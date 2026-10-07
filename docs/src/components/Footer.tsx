import { Link } from "react-router-dom";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="site">
      <div className="wrap">
        <span className="brand" style={{ fontSize: 13.5 }}>
          <Logo />
          easy-ping
        </span>
        <a href="https://github.com/teklumt/easy-ping" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a href="https://www.npmjs.com/package/easy-ping" target="_blank" rel="noreferrer">
          npm
        </a>
        <a href="/llms.txt" target="_blank" rel="noreferrer">
          llms.txt
        </a>
        <Link to="/legal">Legal</Link>
        <span style={{ marginLeft: "auto" }}>MIT · your database, your users</span>
      </div>
    </footer>
  );
}
