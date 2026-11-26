import { PublicationStore } from "./store.js";
import { publishRequest } from "./publisher.js";
process.umask(0o077);
const state = process.argv[2],
  id = process.argv[3];
if (state === undefined || id === undefined) throw new Error("Missing publication state or request ID.");
const store = new PublicationStore(state);
try {
  await publishRequest(store, id);
} finally {
  store.close();
}
