import fs from "node:fs";
import type { RuntimePaths } from "../types.js";

export interface SoundManifestEntry {
  name: string;
  file: string;
  description?: string;
  lengthSeconds?: number;
}

export class SoundService {
  constructor(private readonly paths: RuntimePaths) {}

  listSounds(): SoundManifestEntry[] {
    if (!fs.existsSync(this.paths.soundsManifestFile)) {
      fs.writeFileSync(this.paths.soundsManifestFile, JSON.stringify([], null, 2));
    }
    return JSON.parse(fs.readFileSync(this.paths.soundsManifestFile, "utf8")) as SoundManifestEntry[];
  }

  getSound(name: string): SoundManifestEntry | undefined {
    return this.listSounds().find((sound) => sound.name.toLowerCase() === name.toLowerCase());
  }
}
