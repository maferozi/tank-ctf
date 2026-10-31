import { notFound } from "next/navigation";
import { SpriteSheet } from "./SpriteSheet";

// Dev-only art preview: soldiers and bullets drawn large, for reviewing graphics.
export default function SpritesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SpriteSheet />;
}
