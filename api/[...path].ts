import { handleApiRequest } from "../src/lib/api.server";
import { createNodeApiHandler } from "../src/lib/node-api";

export default createNodeApiHandler(handleApiRequest);
