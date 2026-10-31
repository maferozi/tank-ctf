import { RoomView } from "@/net/RoomView";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomView rawCode={code} />;
}
