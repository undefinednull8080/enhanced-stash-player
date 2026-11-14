// Starts the Docker Stash, configured and seeded with the test clip: `npm run stash` in the repo root.
import { baseURL, sceneId, up } from "./stash.mjs";

await up();
console.log("Stash is up at " + baseURL + "/scenes/" + (await sceneId()) + " (stop it with: docker compose down)");
