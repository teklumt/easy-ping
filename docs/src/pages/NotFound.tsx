import { Link } from "react-router-dom";
import { Head } from "../components/Head";
import { SITE_NAME } from "../lib/site";

export function NotFound() {
  return (
    <main className="wrap section" style={{ paddingTop: 80 }}>
      <Head
        title={`Page not found · ${SITE_NAME}`}
        description="That page doesn't exist, or moved when the docs were reorganized."
        path="/404"
        noindex
      />
      <p className="eyebrow">404</p>
      <h1 style={{ fontSize: "2rem", letterSpacing: "-0.02em" }}>Page not found</h1>
      <p style={{ color: "var(--muted)", marginBottom: 24 }}>
        That page doesn't exist, or moved when the docs were reorganized.
      </p>
      <Link className="btn btn-primary" to="/docs/introduction">
        Go to the docs
      </Link>
    </main>
  );
}
