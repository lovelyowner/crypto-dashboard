import { handlePublicAuthConfigurationRequest } from "../src/lib/auth/public-settings.server.js";
import { createNodeApiHandler } from "../src/lib/node-api.js";

export default createNodeApiHandler(async (request) => {
  // Settings discovery must survive an authentication SDK or database startup failure.
  if (new URL(request.url).pathname === "/api/auth/config")
    return handlePublicAuthConfigurationRequest(request);
  const { handleApiRequest } = await import("../src/lib/api.server.js");
  return handleApiRequest(request);
});
