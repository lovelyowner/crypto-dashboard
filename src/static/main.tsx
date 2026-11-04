import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "@/components/dashboard";
import { PublicCreatorPage } from "@/components/public-creator-page";
import { publicHandleFromPath } from "@/lib/profile-url";
import "../styles.css";

export function App() {
  const [client] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  const publicHandle = publicHandleFromPath(window.location.pathname, window.location.protocol);
  return (
    <QueryClientProvider client={client}>
      {publicHandle === null ? (
        <Dashboard />
      ) : (
        <PublicCreatorPage key={publicHandle} handle={publicHandle} />
      )}
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
