import { useEffect, useState } from "react";
import { fetchImageObjectUrl } from "../lib/api";

type Props = {
  /** The full `/api/...` URL from ReviewDraft.imageUrl. */
  src: string;
  alt: string;
  className?: string;
};

/**
 * Draft images sit behind the same Telegram-auth header as every other API call,
 * so a plain <img src> 401s. This fetches the bytes with the header, shows them
 * via an object URL, and revokes it on unmount. Give it a `key={src}` so a new
 * source remounts it fresh.
 */
export function AuthedImage({ src, alt, className }: Props) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;

    fetchImageObjectUrl(src)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        revoked = url;
        setObjectUrl(url);
      })
      .catch(() => !cancelled && setFailed(true));

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [src]);

  if (failed) return <div className={className} data-image-failed>Image unavailable</div>;
  if (!objectUrl) return <div className={className} data-image-loading aria-busy />;
  return <img src={objectUrl} alt={alt} className={className} />;
}
