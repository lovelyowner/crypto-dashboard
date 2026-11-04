import { createFileRoute } from "@tanstack/react-router";
import { AccountPanel } from "@/components/account-panel";
export const Route = createFileRoute("/login")({ component: Login });
function Login() {
  return (
    <main style={{ minHeight: "100dvh", padding: "40px 24px", background: "#fff" }}>
      <div
        style={{
          maxWidth: 520,
          margin: "auto",
          padding: 24,
          background: "#fff",
          border: "1px solid #ccc",
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
