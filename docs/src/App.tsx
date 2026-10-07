import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { Footer } from "./components/Footer";
import { TopBar } from "./components/TopBar";
import { DocPage } from "./pages/DocPage";
import { Landing } from "./pages/Landing";
import { Legal } from "./pages/Legal";
import { NotFound } from "./pages/NotFound";

function ScrollToTop() {
  const { pathname } = useLocation();
  // pathname drives when this re-runs; it's not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <TopBar />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/docs/:slug" element={<DocPage />} />
        <Route path="/legal" element={<Legal />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Footer />
    </>
  );
}
