/** The sign-in page stands alone: no sidebar, since there is no session yet. */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-ink">{children}</div>;
}
