import { Bell, Check } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CodeBlock } from "../components/CodeBlock";
import { Comparison } from "../components/Comparison";
import { DeviceDemo } from "../components/DeviceDemo";
import { Features } from "../components/Features";
import { Head } from "../components/Head";
import { InstallLine } from "../components/InstallLine";
import { PromptSection } from "../components/PromptSection";
import { CURRENT_VERSION } from "../lib/releases";
import {
  AUTHOR,
  NPM_URL,
  REPO_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from "../lib/site";
import "../styles/landing.css";

const BADGES = [`v${CURRENT_VERSION}`, "MIT", "1 runtime dep", "no services to run"];

const HERO_SNIPPET = `await notify.send("commentReply", {
  to: threadOwnerId,
  payload: { authorName: "Dana", commentId: "c_123" },
  dedupeKey: "commentReply:c_123",
});`;

const MODES = [
  {
    mode: "inline",
    when: "Before send() resolves",
    latency: "in-request",
    cron: "recommended",
  },
  {
    mode: "deferred",
    when: "After the response, via waitUntil",
    latency: "~1 s",
    cron: "yes",
  },
  {
    mode: "worker",
    when: "In-process loop, woken by send()",
    latency: "instant",
    cron: "optional",
  },
  {
    mode: "cron",
    when: "When the sweep runs",
    latency: "up to the interval",
    cron: "yes",
  },
] as const;

type SectionProps = {
  eyebrow: string;
  title: string;
  sub: string;
  children: ReactNode;
  id?: string;
};

/** Every section below the hero shares one rhythm: label, claim, then evidence. */
function Section({ eyebrow, title, sub, children, id }: SectionProps) {
  return (
    <section className="wrap section" id={id}>
      <p className="sec-eyebrow">{eyebrow}</p>
      <h2 className="sec">{title}</h2>
      <p className="sec-sub">{sub}</p>
      {children}
    </section>
  );
}

const JSON_LD = [
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Node.js 20+, edge runtimes",
    softwareVersion: CURRENT_VERSION,
    license: "https://opensource.org/licenses/MIT",
    downloadUrl: NPM_URL,
    sameAs: [REPO_URL, NPM_URL],
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    codeRepository: REPO_URL,
    programmingLanguage: "TypeScript",
    runtimePlatform: "Node.js",
    version: CURRENT_VERSION,
    license: "https://opensource.org/licenses/MIT",
    author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
  },
];

export function Landing() {
  return (
    <main className="landing">
      <Head
        title={`${SITE_NAME} — ${SITE_TAGLINE}`}
        description={SITE_DESCRIPTION}
        path="/"
        jsonLd={JSON_LD}
      />
      <section className="wrap hero">
        <div className="hero-copy">
          <p className="eyebrow">Open-source notifications for TypeScript</p>
          <h1 className="display">
            easy-ping<span className="hero-period">.</span>
          </h1>
          <p className="hero-offer">Add an inbox, email, and push notifications to your app.</p>
          <p className="lede">
            Send once. Deliver to every channel you choose. Respect user preferences. Keep the data
            in your own database.
          </p>

          <div className="cta-row">
            <Link className="btn btn-primary" to="/docs/quickstart">
              Get started
            </Link>
            <a className="btn btn-ghost" href="#demo">
              See it in action
            </a>
          </div>

          <InstallLine command="pnpm add easy-ping" />

          <ul className="badges">
            {BADGES.map((badge) => (
              <li key={badge}>{badge}</li>
            ))}
          </ul>

          <p className="hero-channels">
            In-app inbox <span>/</span> Email <span>/</span> Web push <span>/</span> Telegram{" "}
            <span>/</span> Mobile push <span className="hero-beta">beta</span>
          </p>
        </div>

        <div className="hero-art">
          <div className="hero-code">
            <CodeBlock title="app/api/comments/route.ts">{HERO_SNIPPET}</CodeBlock>
          </div>
          <div className="float-card float-toast" aria-hidden="true">
            <span className="float-icon">
              <Bell size={16} />
            </span>
            <span>
              <strong>Dana replied to your comment</strong>
              <small>"Looks good. Let's ship it!"</small>
            </span>
          </div>
          <div className="float-card float-delivered" aria-hidden="true">
            <span className="float-check">
              <Check size={14} />
            </span>
            <span>
              <strong>Delivered</strong>
              <small>in-app · email · push</small>
            </span>
          </div>
        </div>
      </section>

      <section className="wrap section demo-section" id="demo" aria-labelledby="demo-title">
        <p className="sec-eyebrow">See it work</p>
        <h2 className="sec" id="demo-title">
          One <code>send()</code>. Every screen.
        </h2>
        <p className="sec-sub">
          Press send. The bell updates, a push notification appears, and the email lands on the
          phone.
        </p>
        <DeviceDemo />
      </section>

      <Section
        eyebrow="From your first bell to every channel"
        title="What you can build"
        sub="Start with the inbox. Add channels, preferences, and digests as you grow."
      >
        <Features />
      </Section>

      <section className="wrap stack-section" aria-labelledby="stack-title">
        <div>
          <h2 id="stack-title">Fits the app you already have.</h2>
          <p>Bring your database and authentication. No separate notification service to deploy.</p>
        </div>
        <div className="stack-links">
          <Link to="/docs/postgres-adapter">Postgres</Link>
          <Link to="/docs/drizzle-adapter">Drizzle</Link>
          <Link to="/docs/mysql-adapter">MySQL</Link>
          <Link to="/docs/sqlite-adapter">SQLite</Link>
          <Link to="/docs/mongodb-adapter">MongoDB</Link>
        </div>
      </section>

      <Section
        eyebrow="How it compares"
        title="A library, not another service to run"
        sub="The alternatives are good, and most are platforms you run. easy-ping is a dependency you install. That difference decides almost everything else."
        id="compare"
      >
        <Comparison />
      </Section>

      <Section
        eyebrow="Delivery"
        title="Four ways to deliver, one durability floor"
        sub="Persist first, then deliver. Retries live in your database. Delivery is at-least-once, with no queue service to run."
      >
        <div className="panel">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Delivery happens</th>
                  <th>Latency</th>
                  <th>Needs cron</th>
                </tr>
              </thead>
              <tbody>
                {MODES.map((row) => (
                  <tr key={row.mode}>
                    <td>
                      <code>{row.mode}</code>
                    </td>
                    <td>{row.when}</td>
                    <td className="num">{row.latency}</td>
                    <td className="num">{row.cron}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <section className="wrap section" id="ai">
        <PromptSection />
      </section>

      <section className="wrap">
        <div className="closing">
          <h2>Ship it this afternoon.</h2>
          <p>
            Schema, config, one <code>send()</code>, and the bell. The quickstart covers it in
            order, gotchas included.
          </p>
          <div className="cta-row">
            <Link className="btn btn-primary" to="/docs/quickstart">
              Read the quickstart
            </Link>
            <Link className="btn btn-ghost" to="/docs/introduction">
              What's built, what isn't
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
