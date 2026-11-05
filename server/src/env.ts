// Loads server/.env (if there is one) into process.env before anything reads it. Variables
// already set in the environment win. The file is git-ignored; see server/.env.example and
// docs/VOICE.md for what goes in it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(file) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.warn(`could not read server/.env: ${(err as Error).message}`);
  }
}
