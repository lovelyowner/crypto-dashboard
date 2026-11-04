import { createFileRoute, notFound } from "@tanstack/react-router";
import { PublicCreatorPage } from "@/components/public-creator-page";
import { publicHandleFromPath } from "@/lib/profile-url";

export const Route = createFileRoute("/$handle")({
  beforeLoad: ({ params }) => {
    if (publicHandleFromPath(`/${encodeURIComponent(params.handle)}`) === null) throw notFound();
  },
  component: CreatorPage,
});
function CreatorPage() {
  const { handle } = Route.useParams();
  return <PublicCreatorPage key={handle} handle={handle} />;
}
