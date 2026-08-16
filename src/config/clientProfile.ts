import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const profileSchema = z.object({
  clientName: z.string().min(1),
  oneLiner: z.string().min(1),
  industry: z.string().min(1),
  audience: z.string().min(1),
  voice: z.string().min(1),
  expertiseAreas: z.array(z.string().min(1)).min(1),
  goals: z.array(z.string().min(1)).min(1),
  callToActionStyle: z.string().min(1),
  hashtagPolicy: z.string().min(1),
  avoid: z.array(z.string().min(1)).default([]),
  imageStyle: z.string().min(1),
});

export type ClientProfile = z.infer<typeof profileSchema>;

const profilePath =
  process.env.CLIENT_PROFILE_PATH ?? path.resolve(process.cwd(), "config", "client-profile.json");

function load(): ClientProfile {
  let raw: string;
  try {
    raw = readFileSync(profilePath, "utf8");
  } catch (cause) {
    throw new Error(`Could not read client profile at ${profilePath}`, { cause });
  }
  return profileSchema.parse(JSON.parse(raw));
}

export const clientProfile = load();

/** Compact, prompt-friendly rendering of the profile. */
export function renderProfile(profile: ClientProfile = clientProfile): string {
  return [
    `Client: ${profile.clientName}`,
    `What they do: ${profile.oneLiner}`,
    `Industry: ${profile.industry}`,
    `Audience: ${profile.audience}`,
    `Voice: ${profile.voice}`,
    `Expertise: ${profile.expertiseAreas.join("; ")}`,
    `Goals: ${profile.goals.join("; ")}`,
    `Call to action: ${profile.callToActionStyle}`,
    `Hashtags: ${profile.hashtagPolicy}`,
    profile.avoid.length ? `Never do this: ${profile.avoid.join("; ")}` : "",
    `Image style: ${profile.imageStyle}`,
  ]
    .filter(Boolean)
    .join("\n");
}
