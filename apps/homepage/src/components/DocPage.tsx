// One docs page (X85), laid out as docs/design/marketing-homepage-for-moonlet/pages/docs.html:
// the docs nav, the article, and "On this page".
import { type Doc, docsNav, neighbours, renderDoc } from "@/lib/docs";
import { DocsBehaviour } from "./DocsBehaviour";
import { DEFAULT_ICON, PAGE_ICONS } from "./pageIcons";

const REPO = "https://github.com/1devstudio/moonlet";

function Icon({ inner, size = 14 }: { inner: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: inner }} />;
}

const CHEVRON = '<path d="m9 18 6-6-6-6"/>';

export function DocPage({ doc, docs }: { doc: Doc; docs: Doc[] }) {
  const nav = docsNav(docs);
  const { previous, next } = neighbours(docs, doc.slug);
  const { html, headings } = renderDoc(doc.body);

  return (
    <div className="docs-site">
      <header className="nav">
        <div className="wrap nav__in">
          <a className="brand" href="/">
            <img className="brand__logo" src="/moonlet-icon.svg" alt="" width={32} height={32} />
            moonlet <span className="brand__docs">docs</span>
          </a>
          <nav className="nav__links">
            <a href="/#mesh">Mesh</a>
            <a href="/#design">Design</a>
            <a href="/#tasks">Tasks</a>
            <a className="nav__here" href="/docs">Docs</a>
          </nav>
          <div className="nav__end">
            <button className="button menu-button" aria-expanded="false" aria-controls="docs-nav">
              <Icon inner='<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>' />
              Menu
            </button>
            <label className="search">
              <Icon inner='<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>' />
              <span>Search the docs</span>
              <kbd className="kbd">⌘K</kbd>
            </label>
            <a className="button button--primary" href={`${REPO}/releases/latest`}>Download for macOS</a>
          </div>
        </div>
      </header>

      <div className="wrap docs">
        <aside className="docs__nav docs__nav--closed" id="docs-nav">
          <nav className="settings-nav" aria-label="Docs">
            <div className="settings-nav__groups">
              {nav.map((group) => (
                <div className="settings-nav__group" key={group.title}>
                  <span className="settings-nav__title">{group.title}</span>
                  {group.pages.map((p) => {
                    const here = p.slug === doc.slug;
                    return (
                      <a
                        key={p.slug}
                        href={`/docs/${p.slug}`}
                        className={`settings-nav__entry${here ? " settings-nav__entry--active" : ""}`}
                        aria-current={here ? "page" : undefined}
                      >
                        <Icon inner={PAGE_ICONS[p.slug] ?? DEFAULT_ICON} />
                        <span className="settings-nav__label">{p.title}</span>
                      </a>
                    );
                  })}
                </div>
              ))}
            </div>
          </nav>
        </aside>

        <main className="docs__main">
          <div className="crumbs">
            <a href="/docs">Docs</a>
            <Icon size={11} inner={CHEVRON} />
            <span>{doc.group}</span>
            <Icon size={11} inner={CHEVRON} />
            <span className="crumbs__here">{doc.title}</span>
          </div>
          <h1 className="doc-title">{doc.title}</h1>
          {doc.description && <p className="doc-lede">{doc.description}</p>}
          {doc.tags.length > 0 && (
            <div className="doc-meta">
              {doc.tags.map((t) => (
                <span className="badge" key={t}>{t}</span>
              ))}
            </div>
          )}

          <article className="chat-md doc-prose" dangerouslySetInnerHTML={{ __html: html }} />

          <nav className="pager" aria-label="More docs">
            {previous ? (
              <a className="pager__link" href={`/docs/${previous.slug}`}>
                <div className="pager__dir">Previous</div>
                <div className="pager__title">{previous.title}</div>
              </a>
            ) : (
              <span />
            )}
            {next && (
              <a className="pager__link pager__link--next" href={`/docs/${next.slug}`}>
                <div className="pager__dir">Next</div>
                <div className="pager__title">{next.title}</div>
              </a>
            )}
          </nav>
          <div className="doc-foot">
            <span>moonlet docs · MIT or Apache-2.0</span>
            <a href={`${REPO}/blob/main/apps/homepage/content/docs/${doc.slug}.md`}>Edit this page on GitHub</a>
            <a href={`${REPO}/issues/new?template=bug_report.yml`}>Report a problem</a>
          </div>
        </main>

        <aside className="docs__toc">
          {headings.length > 0 && (
            <>
              <div className="toc__title">On this page</div>
              <ul className="toc__list">
                {headings.map((h) => (
                  <li className={`toc__item${h.depth === 3 ? " toc__item--sub" : ""}`} key={h.id}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="toc__help">
            <div className="toc__help-title">Stuck?</div>
            <p className="toc__help-text">Search the issues, or open one with what you ran and what you saw.</p>
            <a className="button button--sm" href={`${REPO}/issues`}>Open an issue</a>
          </div>
        </aside>
      </div>
      <DocsBehaviour />
    </div>
  );
}
