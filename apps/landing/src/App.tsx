import { DocumentMeta } from "./components/DocumentMeta";
import { Downloads } from "./components/Downloads";
import { Features } from "./components/Features";
import { Hero } from "./components/Hero";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { useScrollSentinel } from "./lib/motion";

/**
 * Three content beats, each a DIFFERENT layout family so the page never reads as
 * one template repeated: the hero is an asymmetric split (copy left, brand mark
 * right), the feature block is a 1+2 bento, and downloads is an intro column
 * beside a list of real actions.
 *
 * No `.shell` wrapper at this level. Each section owns its own centred inner
 * container so a section can paint a full-bleed background without the page
 * shell clipping it.
 *
 * The sentinel is a 1px-wide, out-of-flow marker pinned to the very top of the
 * page. It exists only so the sticky header can know it has left the top of the
 * document without anyone attaching a scroll handler; it is `aria-hidden` and
 * takes no space.
 */
export function App(): JSX.Element {
  const sentinelRef = useScrollSentinel<HTMLSpanElement>();

  return (
    <div className="page">
      <DocumentMeta />
      <span className="scroll-sentinel" aria-hidden="true" ref={sentinelRef} />
      <SiteHeader />
      <main className="page__main" id="main">
        <Hero />
        <Features />
        <Downloads />
      </main>
      <SiteFooter />
    </div>
  );
}
