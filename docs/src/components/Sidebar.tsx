import { NavLink } from "react-router-dom";
import { isLinked, NAV } from "../lib/nav";

/** The doc tree itself. The desktop rail and the mobile drawer both render it. */
export function NavTree({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((group) => (
        <div className="rail-group" key={group.title}>
          <h4>{group.title}</h4>
          {group.items.map((item) =>
            isLinked(item) ? (
              <NavLink
                key={item.slug}
                to={`/docs/${item.slug}`}
                className={({ isActive }) => (isActive ? "active" : "")}
                onClick={onNavigate}
              >
                {item.label}
                {item.beta && <span className="beta">BETA</span>}
              </NavLink>
            ) : (
              <span className="soon-item" key={item.label}>
                {item.label}
                <span className="soon">SOON</span>
              </span>
            ),
          )}
        </div>
      ))}
    </>
  );
}

export function Sidebar() {
  return (
    <nav className="rail" aria-label="Documentation">
      <NavTree />
    </nav>
  );
}
