import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "@/components/dashboard";
import { PublicCreatorPage } from "@/components/public-creator-page";
import "../styles.css";
function publicHandleFromPath(): string | null {
  const match = window.location.pathname.match(/^\/u\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

export function App() {
  const [client] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  const publicHandle = publicHandleFromPath();
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
