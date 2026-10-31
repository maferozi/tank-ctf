// The game title between a red and a blue flag.
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <h1 className={small ? "logo small" : "logo"}>
      <Pennant team="red" />
      <span className="logo-text">Tank CTF</span>
      <Pennant team="blue" />
    </h1>
  );
}

function Pennant({ team }: { team: "red" | "blue" }) {
  return (
    <svg className={`pennant ${team}`} viewBox="0 0 40 52" aria-hidden>
      <rect x="5" y="4" width="5" height="46" rx="2.5" className="pole" />
      <path d="M10 6 C20 2 26 12 36 8 L36 28 C26 32 20 22 10 26 Z" className="cloth" />
    </svg>
  );
}
