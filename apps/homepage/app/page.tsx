// The homepage (X85), built from docs/design/marketing-homepage-for-moonlet/pages/index.html.
import "./home.css";

export default function Home() {
  return (
    <div className="home">
      
      
      <header className="nav">
        <div className="wrap nav__in">
          <div className="brand"><img className="brand__logo" src="/moonlet-icon.svg" alt="" width={32} height={32} />moonlet</div>
          <nav className="nav__links">
            <a href="#mesh">Mesh</a>
            <a href="#phone">Phone</a>
            <a href="#design">Design</a>
            <a href="#tasks">Tasks</a>
            <a href="#open-source">Open source</a>
            <a href="/docs">Docs</a>
          </nav>
          <div className="nav__end">
            <a className="button button--ghost" href="https://github.com/1devstudio/moonlet">GitHub</a>
            <a className="button button--primary" href="https://github.com/1devstudio/moonlet/releases/latest">Download for macOS</a>
          </div>
        </div>
      </header>
      
      <main>
      
      {/* Hero: one mesh of machines, and the phone */}
      <section className="hero">
        <div className="wrap">
          <div className="hero__grid">
            <div>
              <span className="eyebrow">Free and open source · macOS, Linux, iPhone</span>
              <h1 className="h1">Your agents, on every machine you own. <em>Close the lid. They keep going.</em></h1>
              <p className="lede">moonlet links your MacBook, an always-on Mac mini or Linux box, and your iPhone into one mesh. Start a session at your desk, close the lid, and carry on from your phone. It comes back to the Mac when you type there again.</p>
              <div className="cta">
                <a className="button button--primary" href="https://github.com/1devstudio/moonlet/releases/latest">Download for macOS</a>
                <a className="button" href="/docs/pair-your-phone">Pair your phone</a>
                <span className="cta__note">Free · Apple Silicon · macOS 14 or later</span>
              </div>
            </div>
      
            <div className="mesh" aria-label="Three machines in one mesh">
              <svg className="mesh__lines" viewBox="0 0 600 528" preserveAspectRatio="none" aria-hidden="true">
                <line x1="150" y1="130" x2="450" y2="250"/>
                <line className="mesh__live" x1="450" y1="250" x2="270" y2="430"/>
                <line x1="150" y1="130" x2="270" y2="430"/>
              </svg>
      
              <div className="node node--mac node--asleep">
                <div className="node__head">
                  <svg className="icon node__icon" width="14" height="14" viewBox="0 0 24 24"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg>
                  <span className="node__name">macbook</span>
                  <span className="badge">Asleep</span>
                </div>
                <div className="session-row" role="button"><span className="session-row__glyph"><svg className="icon branch-icon" width="15" height="15" viewBox="0 0 24 24" strokeWidth="1.75"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></span><span className="session-row__name">Checkout retries</span><span className="session-row__badge">moved</span></div>
                <div className="node__note"><svg className="icon" width="12" height="12" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>Handed over at 18:42 when the lid closed</div>
              </div>
      
              <div className="node node--hub">
                <div className="node__head">
                  <svg className="icon node__icon" width="14" height="14" viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
                  <span className="node__name">studio-mini</span>
                  <span className="badge">Central host</span>
                </div>
                <div className="session-row session-row--selected" role="button" aria-current="true"><span className="session-row__glyph"><span className="state-glyph state-glyph--15"><span className="moonlet-dots"><i></i><i></i><i></i></span></span></span><span className="session-row__name">Checkout retries</span><span className="session-row__badge">+212 -30</span></div>
                <div className="session-row" role="button"><span className="session-row__glyph"><span className="state-glyph state-glyph--15"><span className="state-glyph__dot state-glyph__dot--done"></span></span></span><span className="session-row__name">Search on the product list</span><span className="session-row__badge">+88 -4</span></div>
                <div className="node__note"><svg className="icon" width="12" height="12" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Continued from the last checkpoint</div>
              </div>
      
              <div className="node node--phone">
                <div className="node__head">
                  <svg className="icon node__icon" width="14" height="14" viewBox="0 0 24 24"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>
                  <span className="node__name">iPhone</span>
                  <span className="badge">On the train</span>
                </div>
                <div className="permission-card">
                  <div className="permission-card__title"><svg className="icon" width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><span>Allow Bash?</span></div>
                  <div className="permission-card__summary"><code>pnpm --filter storefront test</code></div>
                  <div className="permission-card__actions">
                    <button className="button button--sm button--primary">Allow</button>
                    <button className="button button--sm">Always allow</button>
                    <button className="button button--sm button--ghost">Deny</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
      
          <ol className="handover" aria-label="One evening with moonlet">
            <li className="handover__step">
              <span className="handover__time">18:30 · macbook</span>
              <div className="handover__title"><span className="state-glyph"><span className="moonlet-dots"><i></i><i></i><i></i></span></span>Start a session</div>
              <p className="handover__text">Claude Code works in its own worktree. After every tool call, studio-mini gets a checkpoint.</p>
            </li>
            <li className="handover__step">
              <span className="handover__time">18:42 · lid closed</span>
              <div className="handover__title"><svg className="icon" width="14" height="14" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>The MacBook sleeps</div>
              <p className="handover__text">studio-mini carries on from the last checkpoint, including the turn that sleep cut off.</p>
            </li>
            <li className="handover__step">
              <span className="handover__time">19:05 · iPhone</span>
              <div className="handover__title"><span className="state-glyph"><span className="state-glyph__dot state-glyph__dot--blocked"></span></span>Answer from the phone</div>
              <p className="handover__text">The agent asks to run the tests. You allow it on the train, and review the diff.</p>
            </li>
            <li className="handover__step">
              <span className="handover__time">09:10 · macbook</span>
              <div className="handover__title"><span className="state-glyph"><span className="state-glyph__dot state-glyph__dot--done"></span></span>Back at the desk</div>
              <p className="handover__text">Type into the session and it moves back to the MacBook once the current turn ends.</p>
            </li>
          </ol>
        </div>
      </section>
      
      {/* The mesh, in detail */}
      <section className="section" id="mesh">
        <div className="wrap">
          <div className="section__head">
            <span className="eyebrow">One mesh of machines</span>
            <h2 className="h2">The machines you own, working as one.</h2>
            <p className="lede">Your Macs, a Linux VPS and your phone pair once over your Tailscale tailnet. There are no SSH keys and no port forwarding. One of them is always on and keeps a copy of everything.</p>
          </div>
          <div className="features">
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg></span>
              <h3 className="feature__title">The same workspaces everywhere</h3>
              <p className="feature__text">Workspaces, sections, design systems and designs are on every machine. A change made on one shows up on the others within seconds.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/></svg></span>
              <h3 className="feature__title">Every session has a copy</h3>
              <p className="feature__text">The machine running an agent checkpoints the worktree and the transcript after every tool call. Nothing lives only on the laptop.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg></span>
              <h3 className="feature__title">Sessions follow you</h3>
              <p className="feature__text">Close the lid and the central host continues. Type on another Mac and the session moves there. <strong>Move to</strong> a machine pins it there when you want it to stay put.</p>
            </article>
            <article className="feature" id="phone">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg></span>
              <h3 className="feature__title">Switch to your phone in one step</h3>
              <p className="feature__text">Scan a code to pair. The iPhone app lists every session wherever it runs, answers prompts and plans, and opens chat, terminal, changes and PR.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
              <h3 className="feature__title">What git ignores comes along</h3>
              <p className="feature__text"><code>.env</code> files and the patterns you list are copied between machines. Sign-ins like <code>gh auth login</code> open where you are.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg></span>
              <h3 className="feature__title">Heavy work goes to free machines</h3>
              <p className="feature__text">Test suites run on the least busy machine, or on a cloud machine made for the job and removed when idle. Follow each run in <strong>Jobs</strong>.</p>
            </article>
          </div>
        </div>
      </section>
      
      {/* Hosts and workers: where heavy work runs */}
      <section className="section" id="workers">
        <div className="wrap">
          <div className="section__head">
            <span className="eyebrow">Hosts and workers</span>
            <h2 className="h2">Heavy work goes where there is room.</h2>
            <p className="lede">Hosts run your agents. Workers lend their CPU. When an agent runs a command you marked as heavy, moonlet sends it to the least busy machine, and makes a cloud worker when every machine is full.</p>
          </div>
      
          <div className="route" aria-label="A heavy command routed to the least busy machine">
            <svg className="route__lines" viewBox="0 0 1200 560" preserveAspectRatio="none" aria-hidden="true">
              <path className="route__line route__line--live" d="M276 286 H372"/>
              <path className="route__line" d="M600 286 C636 286 636 108 684 108"/>
              <path className="route__line" d="M600 286 C636 286 636 160 684 160"/>
              <path className="route__line route__line--live" d="M600 286 C636 286 636 212 684 212"/>
              <path className="route__line route__line--cloud" d="M600 286 C636 286 636 420 684 420"/>
            </svg>
      
            <div className="route__source">
              <div className="route__label">An agent runs</div>
              <div className="route__card">
                <div className="session-row" role="button"><span className="session-row__glyph"><span className="state-glyph state-glyph--15"><span className="moonlet-dots"><i></i><i></i><i></i></span></span></span><span className="session-row__name">Checkout retries</span><span className="session-row__badge">macbook</span></div>
                <div className="tool-row"><button className="tool-row__header"><svg className="icon tool-row__icon" width="14" height="14" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg><span className="tool-row__name">Bash</span><span className="tool-row__summary">pnpm test</span></button></div>
                <div className="route__tag"><span className="job-dot job-dot--going" aria-hidden="true"></span>Heavy command, approved by you</div>
              </div>
            </div>
      
            <div className="route__router">
              <div className="route__label">The central host routes it</div>
              <div className="route__card route__card--router">
                <div className="route__machine"><svg className="icon worker-icon" width="14" height="14" viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg><span className="route__name">studio-mini</span><span className="badge">Central host</span></div>
                <p className="route__text">Picks the free machine with the lowest load. The agent stays where it is, and the output comes back to it.</p>
              </div>
            </div>
      
            <div className="route__group route__group--hosts">
              <div className="route__group-head"><span className="route__group-title">Hosts</span><span className="route__group-note">run sessions and agents, and take heavy work too</span></div>
              <div className="route__row"><svg className="icon worker-icon" width="14" height="14" viewBox="0 0 24 24"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg><span className="route__name">macbook</span><span className="badge">This Mac</span><span className="load-bar"><span className="load-bar__text">3 of 4</span><span className="load-bar__track"><span className="load-bar__fill" style={{ width: "75%" }}></span></span></span></div>
              <div className="route__row"><svg className="icon worker-icon" width="14" height="14" viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg><span className="route__name">studio-mini</span><span className="badge">Central host</span><span className="load-bar"><span className="load-bar__text load-bar__text--busy">4 of 4</span><span className="load-bar__track"><span className="load-bar__fill load-bar__fill--busy" style={{ width: "100%" }}></span></span></span></div>
              <div className="route__row route__row--picked"><svg className="icon worker-icon" width="14" height="14" viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg><span className="route__name">vps-fsn</span><span className="badge">Linux</span><span className="load-bar"><span className="load-bar__text">1 of 8</span><span className="load-bar__track"><span className="load-bar__fill" style={{ width: "12%" }}></span></span></span><span className="route__runs"><span className="job-dot job-dot--going" aria-hidden="true"></span>Runs here</span></div>
            </div>
      
            <div className="route__group route__group--workers">
              <div className="route__group-head"><span className="route__group-title">Workers</span><span className="route__group-note">lend their CPU, and never hold your account</span></div>
              <div className="machine-card">
                <div className="machine-card__head"><svg className="icon" width="14" height="14" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg><span className="machine-card__name">hetzner-cx32-a</span><span className="machine-card__kind">Cloud worker · cx32 · fsn1</span></div>
                <div className="machine-card__steps">
                  <div className="machine-card__step"><span className="machine-card__mark machine-card__mark--done"><svg className="icon" width="13" height="13" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span><span className="machine-card__step-body"><span className="machine-card__label">Create the server</span></span><span className="machine-card__took">0:14</span></div>
                  <div className="machine-card__step"><span className="machine-card__mark machine-card__mark--done"><svg className="icon" width="13" height="13" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span><span className="machine-card__step-body"><span className="machine-card__label">Install moonlet</span></span><span className="machine-card__took">0:31</span></div>
                  <div className="machine-card__step"><span className="machine-card__mark machine-card__mark--done"><svg className="icon" width="13" height="13" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span><span className="machine-card__step-body"><span className="machine-card__label">Join the workers</span></span><span className="machine-card__took">0:06</span></div>
                </div>
                <div className="machine-card__deadline">Made when every host is busy. Removed when it is idle.</div>
              </div>
            </div>
          </div>
      
          <div className="route-notes">
            <div className="route-note"><span className="route-note__title">Hosts</span><p className="route-note__text">Your MacBook, a Mac mini, a Linux VPS. Each keeps the whole account and can run sessions.</p></div>
            <div className="route-note"><span className="route-note__title">Workers</span><p className="route-note__text">Cloud machines on Hetzner or Google Cloud, made for heavy commands and billed by your own provider.</p></div>
            <div className="route-note"><span className="route-note__title">Jobs</span><p className="route-note__text">Every routed command is a job in the session's Jobs tab: where it ran, its output and what came back.</p></div>
          </div>
        </div>
      </section>
      
      {/* Design systems and quick prototypes */}
      <section className="section" id="design">
        <div className="wrap split">
          <div>
            <span className="eyebrow">Design systems and prototypes</span>
            <h2 className="h2">Prototype the screen before the agent writes the code.</h2>
            <p className="lede">An agent turns your project's code into a design system. Then you sketch new screens on it in minutes, without running the project.</p>
            <ol className="steps">
              <li className="steps__item">
                <span className="steps__n">1</span>
                <div><div className="steps__title">A design system from your code</div><p className="steps__text">Tokens, type, spacing and one card per component with every variant, in plain HTML and CSS. Any stack works, and a sync only redoes the cards whose source changed.</p></div>
              </li>
              <li className="steps__item">
                <span className="steps__n">2</span>
                <div><div className="steps__title">Design mode <kbd className="kbd">⌃⌘D</kbd></div><p className="steps__text">Describe a screen and an agent builds it live on a canvas. Chat, pin comments on elements, or move and restyle them yourself. Every turn is a snapshot.</p></div>
              </li>
              <li className="steps__item">
                <span className="steps__n">3</span>
                <div><div className="steps__title">Build it</div><p className="steps__text">Start a session with the design attached. The prototype, its spec and the code ship in the same pull request.</p></div>
              </li>
            </ol>
          </div>
      
          <div className="shot" aria-label="Design mode">
            <div className="shot__bar">
              <span className="shot__dots"><i></i><i></i><i></i></span>
              <span className="shot__title">Storefront checkout · Moonlet design system</span>
              <div className="mode-switch" role="group" aria-label="Mode">
                <button className="mode-switch__item" aria-label="Sessions" aria-pressed="false"><svg className="icon" width="14" height="14" viewBox="0 0 24 24"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg></button>
                <button className="mode-switch__item" aria-label="Tasks" aria-pressed="false"><svg className="icon" width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/></svg></button>
                <button className="mode-switch__item mode-switch__item--on" aria-label="Design" aria-pressed="true"><svg className="icon" width="14" height="14" viewBox="0 0 24 24"><path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/></svg></button>
              </div>
            </div>
            <div className="canvas">
              <div className="canvas__chat">
                <div className="canvas__bubble">A one-page checkout with the order summary on the right</div>
                <div className="canvas__reply">Built <span className="mono">checkout.html</span> from Card, Field and Button. The summary uses the panel surface.</div>
                <div className="canvas__bubble">Make the shipping options cards instead of a list</div>
                <div className="canvas__reply"><span className="state-glyph"><span className="moonlet-dots"><i></i><i></i><i></i></span></span></div>
              </div>
              <div className="canvas__stage">
                <div className="page">
                  <div className="page__nav"><strong>Storefront</strong><span>Cart</span><span>Shipping</span><span>Pay</span></div>
                  <div className="page__hero">Shipping</div>
                  <div className="page__line"></div>
                  <div className="page__line page__line--short"></div>
                  <div className="page__cards">
                    <div className="page__card"></div>
                    <div className="page__card page__card--selected"><span className="page__pin pin-badge">1</span></div>
                    <div className="page__card"></div>
                  </div>
                  <div className="comment-box canvas__comment" role="dialog" aria-label="Comment">
                    <div className="comment-box__head"><span className="pin-badge">1</span><span className="comment-box__label">div · m24 · "Express"</span><button className="comment-box__close" aria-label="Close">×</button></div>
                    <div className="comment-box__text">Show the delivery date under the price</div>
                    <div className="comment-box__foot"><span className="comment-box__hint">⌘↵ sends to the chat</span><button className="button button--sm button--ghost">Keep</button><button className="button button--sm button--primary">Send</button></div>
                  </div>
                </div>
                <span className="edits-chip canvas__chip" aria-label="Edits by hand"><svg className="icon" width="11" height="11" viewBox="0 0 24 24"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg><span className="edits-chip__text">2 edits by hand · go with your next message</span></span>
              </div>
            </div>
          </div>
        </div>
      </section>
      
      {/* Start from a task */}
      <section className="section" id="tasks">
        <div className="wrap split split--flip">
          <div className="shot" aria-label="Tasks mode">
            <div className="shot__bar">
              <span className="shot__dots"><i></i><i></i><i></i></span>
              <span className="shot__title">Storefront · Sprint 14</span>
            </div>
            <div className="board">
              <div className="board__col">
                <div className="board__head"><svg className="task-glyph task-glyph--todo" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle className="task-glyph__ring" cx="7" cy="7" r="5.5"/></svg>Todo<span className="board__count">4</span></div>
                <article className="task-card task-card--selected" aria-label="SHOP-218 Retry failed card payments">
                  <div className="task-card__head"><span className="task-card__key">SHOP-218</span><span className="task-card__type">Bug</span><span className="task-card__priority" title="High"><span className="task-card__bar task-card__bar--on"></span><span className="task-card__bar task-card__bar--on"></span><span className="task-card__bar task-card__bar--on"></span></span><span className="task-card__spacer"></span><span className="task-card__assignee" title="Assigned to Alex Rivera">AR</span></div>
                  <button className="task-card__title">Retry failed card payments</button>
                  <div className="task-card__empty"><span>No sessions</span><button className="task-card__start">Start</button></div>
                </article>
                <article className="task-card" aria-label="SHOP-221 Gift cards at checkout">
                  <div className="task-card__head"><span className="task-card__key">SHOP-221</span><span className="task-card__priority" title="Medium"><span className="task-card__bar task-card__bar--on"></span><span className="task-card__bar task-card__bar--on"></span><span className="task-card__bar"></span></span><span className="task-card__spacer"></span><span className="task-card__points">2 pt</span></div>
                  <button className="task-card__title">Gift cards at checkout</button>
                </article>
              </div>
              <div className="board__col">
                <div className="board__head"><svg className="task-glyph" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle className="task-glyph__ring" cx="7" cy="7" r="5.5"/><path className="task-glyph__pie" d="M7 7 L7 4 A3 3 0 0 1 7 10 Z"/></svg>In progress<span className="board__count">2</span></div>
                <article className="task-card" aria-label="SHOP-209 Search on the product list">
                  <div className="task-card__head"><span className="task-card__key">SHOP-209</span><span className="task-card__type">Feature</span><span className="task-card__spacer"></span><span className="task-card__points">3 pt</span><span className="task-card__assignee">AR</span></div>
                  <button className="task-card__title">Search on the product list</button>
                  <div className="task-card__sessions"><div className="task-card__rows">
                    <button className="task-card__session"><span className="state-glyph"><span className="moonlet-dots"><i></i><i></i><i></i></span></span><span className="task-card__session-name">Search on the product list</span><span className="task-card__session-meta">+212</span></button>
                    <button className="task-card__session"><span className="state-glyph"><span className="state-glyph__dot state-glyph__dot--blocked"></span></span><span className="task-card__session-name">Search ranking spike</span><span className="task-card__session-meta task-card__session-meta--blocked">needs you</span></button>
                  </div></div>
                </article>
              </div>
              <div className="board__col">
                <div className="board__head"><svg className="task-glyph" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle className="task-glyph__ring" cx="7" cy="7" r="5.5"/><path className="task-glyph__pie" d="M7 7 L7 4 A3 3 0 1 1 4 7 Z"/></svg>In review<span className="board__count">1</span></div>
                <article className="task-card" aria-label="SHOP-197 Saved addresses">
                  <div className="task-card__head"><span className="task-card__key">SHOP-197</span><span className="task-card__spacer"></span><span className="task-card__assignee">JK</span></div>
                  <button className="task-card__title">Saved addresses</button>
                  <div className="task-card__sessions"><div className="task-card__rows">
                    <button className="task-card__session"><span className="state-glyph"><span className="state-glyph__dot state-glyph__dot--done"></span></span><span className="task-card__session-name">Saved addresses</span><span className="task-card__session-meta task-card__session-meta--open">#41</span></button>
                  </div></div>
                  <div className="task-card__drift"><span className="task-card__drift-text">PR open, still In Progress</span><button className="task-card__drift-fix">Move to In Review</button></div>
                </article>
              </div>
            </div>
            <div className="composer-peek" aria-label="New session from SHOP-218">
              <span className="composer-peek__chip"><span className="mono">SHOP-218</span>Retry failed card payments</span>
              <div className="composer-peek__text">Use the retry policy from the payments service. Add a test for a declined card.</div>
              <div className="composer-peek__foot">
                <span>storefront</span><span>·</span><span className="composer-peek__branch">shop-218-retry-failed-card-payments</span>
                <span className="check"><span className="check__box"><svg className="icon" width="10" height="10" viewBox="0 0 24 24" strokeWidth="3"><path d="M20 6 9 17l-5-5"/></svg></span>Move to In Progress</span>
                <button className="button button--sm button--primary">Create</button>
              </div>
            </div>
          </div>
      
          <div>
            <span className="eyebrow">Start from a task</span>
            <h2 className="h2">Pick an issue. The session starts from it.</h2>
            <p className="lede">moonlet shows your tracker's board beside the sessions and pull requests working on each issue, and keeps the tracker in step as the work moves.</p>
            <div className="trackers" aria-label="Trackers">
              <span className="tracker"><svg className="tracker-icon tracker-icon--linear" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/></svg>Linear</span>
              <span className="tracker"><svg className="tracker-icon tracker-icon--jira" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"/></svg>Jira Cloud</span>
              <span className="tracker"><svg className="tracker-icon tracker-icon--clickup" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z"/></svg>ClickUp</span>
              <span className="tracker"><span className="board-tile board-tile--16 board-tile--github" aria-hidden="true"><span className="board-tile__gh">GH</span></span>GitHub Issues</span>
            </div>
            <ol className="steps">
              <li className="steps__item">
                <span className="steps__n">1</span>
                <div><div className="steps__title">Start on a card</div><p className="steps__text">The issue's title and description become the first message, with the project picked and a branch named after the issue.</p></div>
              </li>
              <li className="steps__item">
                <span className="steps__n">2</span>
                <div><div className="steps__title">The tracker keeps in step</div><p className="steps__text">The issue moves when the session starts, when its PR opens and when it merges. A task whose state no longer matches its work says so, with a one-click fix.</p></div>
              </li>
              <li className="steps__item">
                <span className="steps__n">3</span>
                <div><div className="steps__title">On the phone too</div><p className="steps__text">Move tasks, comment, create issues and start a session from a task while you are away from the desk.</p></div>
              </li>
            </ol>
          </div>
        </div>
      </section>
      
      {/* Free and open source */}
      <section className="section" id="open-source">
        <div className="wrap">
          <div className="section__head">
            <span className="eyebrow">Free and open source</span>
            <h2 className="h2">Free, open source, and yours.</h2>
            <p className="lede">moonlet costs nothing and its source is on GitHub. It runs on machines you own, with the agents and logins you already have.</p>
          </div>
          <div className="features features--4">
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg></span>
              <h3 className="feature__title">Free to use</h3>
              <p className="feature__text">No price, no plan and no seats. Cloud machines, when you use them, are billed by your own provider.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg></span>
              <h3 className="feature__title">MIT or Apache-2.0</h3>
              <p className="feature__text">Pick either license. Read the code, build it yourself, fork it and change it.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg></span>
              <h3 className="feature__title">Your machines, your agents</h3>
              <p className="feature__text">Sessions run on your Macs and Linux boxes, and they talk over your own tailnet. Claude Code and Codex use your own logins.</p>
            </article>
            <article className="feature">
              <span className="feature__icon"><svg className="icon" width="16" height="16" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg></span>
              <h3 className="feature__title">Built in the open</h3>
              <p className="feature__text">Every feature has a public spec, and the big decisions are written down as ADRs. Bug reports, ideas and pull requests are welcome.</p>
            </article>
          </div>
          <div className="repo">
            <span className="board-tile board-tile--26 board-tile--github" aria-hidden="true"><span className="board-tile__gh">GH</span></span>
            <div className="repo__body">
              <div className="repo__name">1devstudio/moonlet</div>
              <div className="repo__line">Rust daemon, Tauri app, iPhone app · MIT or Apache-2.0</div>
            </div>
            <a className="button" href="https://github.com/1devstudio/moonlet/blob/main/CONTRIBUTING.md">Read the contributing guide</a>
            <a className="button button--primary" href="https://github.com/1devstudio/moonlet">View the source</a>
          </div>
        </div>
      </section>
      
      {/* Closing call to action */}
      <section className="closing" id="get-started">
        <div className="wrap">
          <span className="eyebrow">Get started</span>
          <h2 className="h2">Start on the Mac. Carry on anywhere.</h2>
          <p className="lede">Install the app on your Mac, add an always-on machine when you want one, and pair your phone.</p>
          <div className="cta">
            <a className="button button--primary" href="https://github.com/1devstudio/moonlet/releases/latest">Download for macOS</a>
            <a className="button" href="/docs">Read the docs</a>
          </div>
          <div className="install"><span>Linux host</span><b>curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh</b></div>
        </div>
      </section>
      
      </main>
      
      <footer className="footer">
        <div className="wrap footer__in">
          <span>moonlet · MIT or Apache-2.0</span>
          <a href="https://github.com/1devstudio/moonlet">GitHub</a>
          <a href="https://github.com/1devstudio/moonlet/releases">Releases</a>
          <a href="https://github.com/1devstudio/moonlet/blob/main/docs/specs/README.md">Specs</a>
          <a href="https://github.com/1devstudio/moonlet/blob/main/SECURITY.md">Security</a>
        </div>
      </footer>
      
    </div>
  );
}
