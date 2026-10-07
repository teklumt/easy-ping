import { Link } from "react-router-dom";
import { adjacent } from "../lib/nav";

export function Pager({ slug }: { slug: string }) {
  const { prev, next } = adjacent(slug);
  if (!prev && !next) return null;

  return (
    <div className="pager">
      {prev ? (
        <Link to={`/docs/${prev.slug}`}>
          <small>Previous</small>
          <strong>{prev.label}</strong>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link to={`/docs/${next.slug}`} className="pager-next">
          <small>Next</small>
          <strong>{next.label}</strong>
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
