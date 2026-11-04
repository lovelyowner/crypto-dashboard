import { createFileRoute } from "@tanstack/react-router";
import { PublicCreatorPage } from "@/components/public-creator-page";

export const Route = createFileRoute("/u/$handle")({ component: CreatorPage });
function CreatorPage() {
  const { handle } = Route.useParams();
  return <PublicCreatorPage key={handle} handle={handle} />;
}
