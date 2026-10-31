import Link from "next/link";

export default function Home() {
  return (
    <main className="home">
      <h1>TANK CTF</h1>
      <p>One button. Tap to shoot, hold to drive. Online lobbies and voice chat are coming next.</p>
      <Link className="button" href="/play">
        Play solo prototype
      </Link>
    </main>
  );
}
