import { createFileRoute } from "@tanstack/react-router";
import { AccountPanel } from "@/components/account-panel";
export const Route = createFileRoute("/login")({ component: Login });
function Login() {
  return (
    <main style={{ minHeight: "100dvh", padding: "40px 24px", background: "#0b111b" }}>
      <div
        style={{
          maxWidth: 520,
          margin: "auto",
          padding: 24,
          background: "#121c2a",
          border: "1px solid #28374c",
          borderRadius: 20,
        }}
      >
        <AccountPanel
          onClose={() => {
            window.location.assign("/");
          }}
        />
      </div>
    </main>
  );
}
