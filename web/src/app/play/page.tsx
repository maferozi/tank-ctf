import { SoloGame } from "@/game/SoloGame";

// Solo practice. /play?map=garden practises on a particular map.
export default async function PlayPage({ searchParams }: { searchParams: Promise<{ map?: string }> }) {
  const { map } = await searchParams;
  return <SoloGame mapId={typeof map === "string" ? map : undefined} />;
}
