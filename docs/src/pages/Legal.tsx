import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Head } from "../components/Head";
import { SITE_NAME } from "../lib/site";

const EMAIL = "teklumo.jembere@gmail.com";
const TELEGRAM = "tsemadre";
const UPDATED = "22 September 2026";

const SECTIONS = [
  { id: "license", label: "License" },
  { id: "privacy", label: "Privacy" },
  { id: "terms", label: "Terms" },
  { id: "contact", label: "Contact" },
];

const MIT = `MIT License

Copyright (c) 2026 Teklu Moges and easy-ping contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * Standalone page, deliberately outside the docs shell: it has no sidebar,
 * no TOC and no pager, because it is not something anyone reads their way
 * through. They arrive from the footer looking for one specific answer.
 */
export function Legal() {
  const { hash } = useLocation();

  // App's ScrollToTop fires on every navigation and would undo a #fragment
  // jump, so the deep link is re-applied here after the page mounts.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <main className="wrap section legal">
      <Head
        title={`Legal · ${SITE_NAME}`}
        description="License, privacy and terms for the easy-ping documentation site."
        path="/legal"
      />
      <p className="eyebrow">Legal</p>
      <h1>License, privacy and terms</h1>
      <p className="legal-lede">
        easy-ping is an MIT-licensed library you run on your own infrastructure.
        That single fact settles most of what a page like this normally has to
        spell out.
      </p>

      <nav className="legal-nav" aria-label="Sections">
        {SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            {section.label}
          </a>
        ))}
        <span className="legal-updated">Last updated {UPDATED}</span>
      </nav>

      <section className="legal-section">
        <h2 id="license">License</h2>
        <p>
          The library, its documentation and this website are released under the
          MIT license. You may use easy-ping commercially, modify it, ship it
          inside a closed-source product and redistribute it. The one condition
          is that the copyright notice below travels with any substantial copy
          of the code.
        </p>
        <pre className="code legal-license">
          <code>{MIT}</code>
        </pre>
        <p className="legal-note">
          The text above is the license. Everything else on this page is a
          plain-language description of how the project is run, not a
          replacement for it.
        </p>
      </section>

      <section className="legal-section">
        <h2 id="privacy">Privacy</h2>

        <h3>The library</h3>
        <p>
          easy-ping has no telemetry, no usage reporting, no license check and
          no hosted service behind it. Notifications, recipients, payloads and
          delivery records live in <strong>your</strong> database and are never
          transmitted to the maintainers. There is no endpoint for them to be
          transmitted to.
        </p>
        <p>
          The only outbound requests it makes are the ones you configure. It
          calls your email provider when you enable the email channel, and the
          push service named in each browser's own subscription when you enable
          web push. Both are direct from your server to that service, under your
          own credentials.
        </p>

        <h3>This website</h3>
        <p>
          There are no analytics, no tracking pixels, no advertising and no
          cookies. Concretely:
        </p>
        <ul>
          <li>
            <strong>One browser-storage entry.</strong> The light/dark choice is
            kept in <code>localStorage</code> under the key <code>theme</code>.
            It never leaves the browser, and clearing site data removes it.
          </li>
          <li>
            <strong>Fonts are served by Google.</strong> The pages load IBM Plex
            from <code>fonts.googleapis.com</code>, which means Google sees the
            request and therefore your IP address and user agent. Nothing else
            on the site talks to a third party.
          </li>
          <li>
            <strong>Standard server logs.</strong> The site is static and hosted
            on Vercel, which keeps ordinary access logs (IP, timestamp, path)
            under its own privacy policy. Neither they nor the maintainers build
            a profile from them.
          </li>
          <li>
            <strong>Nothing you type is sent anywhere.</strong> The AI prompt
            buttons copy text to your clipboard locally. No search box, form or
            account exists on this site.
          </li>
        </ul>
        <p>
          Writing to the address below shares your email address with the
          maintainer, which is used only to answer you.
        </p>
      </section>

      <section className="legal-section">
        <h2 id="terms">Terms</h2>
        <p>
          Using easy-ping means accepting the MIT license, and the part of it
          that matters most is the last paragraph. The software is provided{" "}
          <em>as is</em>, without warranty of any kind. It is a library that
          moves notifications, so you remain responsible for what you send, to
          whom, and for complying with the marketing, consent and
          data-protection rules that apply where your users are.
        </p>
        <p>
          The project is maintained in the open, without any service-level
          agreement. Issues and questions are answered as time allows, and no
          response time is promised or implied. Versions before 1.0 may move
          APIs on a minor release, and the{" "}
          <Link to="/docs/changelog">changelog</Link> records every such change.
        </p>
        <p>
          The name <strong>easy-ping</strong> and its logo identify this
          project. You are welcome to say your product is built with easy-ping,
          and to reproduce the name and logo when referring to it. Please don't
          use either to imply that this project endorses, sponsors or maintains
          something it does not.
        </p>
      </section>

      <section className="legal-section">
        <h2 id="contact">Contact</h2>
        <p>Anything on this page, or anything else about the project:</p>
        <ul className="legal-contact">
          <li>
            <a
              href={`mailto:${EMAIL}?subject=${encodeURIComponent("easy-ping")}`}
            >
              {EMAIL}
            </a>
          </li>
          <li>
            <a
              href={`https://t.me/${TELEGRAM}`}
              target="_blank"
              rel="noreferrer"
            >
              Telegram @{TELEGRAM}
            </a>
          </li>
          <li>
            <a
              href="https://github.com/teklumt/easy-ping/issues"
              target="_blank"
              rel="noreferrer"
            >
              GitHub issues
            </a>{" "}
            , the right place for bugs
          </li>
        </ul>
      </section>
    </main>
  );
}
