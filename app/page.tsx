"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

type GenerateResponse = {
  job_id?: string;
};

type StatusResponse = {
  job_id?: string;
  status?: string; // queued | running | done | error | unknown
  step?: string;
  progress?: number; // 0..100
  message?: string;
  error?: string | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type ImageItem = string | { url: string; label?: string };

const isImageObj = (x: any): x is { url: string; label?: string } =>
  x && typeof x === "object" && typeof x.url === "string";

const normalizeImages = (arr: any): string[] => {
  if (!Array.isArray(arr)) return [];
  // Convert both formats into a clean string[]
  return arr
    .map((x) => (typeof x === "string" ? x : isImageObj(x) ? x.url : null))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
};

function HomeContent() {
  const searchParams = useSearchParams();
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(3);

  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const [images, setImages] = useState<string[]>([]);
  const [zipUrl, setZipUrl] = useState<string | null>(null);
  const [paymentRequired, setPaymentRequired] = useState<boolean>(false);
  const [seoData, setSeoData] = useState<{ title: string; description: string; keywords: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payLoading, setPayLoading] = useState(false);

  // Progress
  const [status, setStatus] = useState<string>("idle");
  const [step, setStep] = useState<string>("");
  const [progress, setProgress] = useState<number>(0);
  const [message, setMessage] = useState<string>("");

  const canGenerate = useMemo(
    () => prompt.trim().length > 2 && !loading,
    [prompt, loading]
  );

  const absolutize = (pathOrUrl: unknown) => {
    if (typeof pathOrUrl !== "string") return "";
    if (!pathOrUrl) return pathOrUrl;
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
    return `${API_BASE}${pathOrUrl}`;
  };

  const labelFor = (pathOrUrl: string) => {
    if (!pathOrUrl) return "Image";

    const clean = pathOrUrl.split("?")[0];
    const base = clean.split("/").pop()?.toLowerCase() ?? "";

    // Print files
    if (base === "print_ready.png" || base.includes("print_ready") || base.startsWith("print_")) return "Print File - Universal";

    // Mockups
    if (base === "mockup_blue.png") return "Mockup - Blue Shirt";

    // Legacy / internal (if ever shown)
    if (base.startsWith("preview_print_")) return "Preview Print (Internal)";
    if (base.includes("01_original")) return "Original";
    if (base.includes("02_upscaled")) return "Upscaled";
    if (base.includes("03_transparent")) return "Transparent Cutout";

    // Fallback
    if (base.startsWith("mockup_")) return "Mockup";
    if (base.startsWith("print_")) return "Print File";

    return base || "Image";
  };

  async function fetchJob(job_id: string) {
    const res = await fetch(`${API_BASE}/job/${job_id}`, { cache: "no-store" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Job fetch failed (${res.status}) ${txt}`);
    }
    const data = await res.json();

    setImages(normalizeImages(data.images));
    setZipUrl(data.zip ? data.zip : null);
    setPaymentRequired(Boolean(data.payment_required));
    setSeoData(data.seo ? data.seo : null);
  }

  async function handlePayToDownload() {
    if (!jobId || payLoading) return;
    setPayLoading(true);
    try {
      const res = await fetch(`${API_BASE}/payment/create-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.detail || "Checkout failed");
      if (json.url) {
        window.location.href = json.url;
        return;
      }
      throw new Error("No checkout URL returned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
      setPayLoading(false);
    }
  }

  // Poll status while running
  useEffect(() => {
    if (!jobId) return;

    let timer: any = null;
    let stopped = false;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/job/${jobId}/status`, { cache: "no-store" });
        if (!res.ok) {
          timer = setTimeout(poll, 2000);
          return;
        }

        const s: StatusResponse = await res.json();
        if (stopped) return;

        const nextStatus = s.status ?? "unknown";
        const nextStep = s.step ?? "";
        const nextProgress = typeof s.progress === "number" ? s.progress : 0;
        const nextMessage = s.message ?? "";

        setStatus(nextStatus);
        setStep(nextStep);
        setProgress(nextProgress);
        setMessage(nextMessage);

        if (nextStatus === "done") {
          await fetchJob(jobId);
          setLoading(false);
          return;
        }

        if (nextStatus === "error") {
          setLoading(false);
          setError(s.error ?? "Job failed");
          return;
        }

        timer = setTimeout(poll, 1500);
      } catch {
        timer = setTimeout(poll, 2000);
      }
    };

    poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  // When returning from Stripe (e.g. ?job_id=xxx&paid=1), load job so download link appears
  useEffect(() => {
    const qJobId = searchParams.get("job_id");
    if (qJobId && qJobId.trim()) {
      setJobId(qJobId.trim());
      fetchJob(qJobId.trim());
    }
  }, [searchParams]);

  const generateDesigns = async () => {
    setError(null);
    setImages([]);
    setZipUrl(null);
    setPaymentRequired(false);

    // reset progress
    setStatus("queued");
    setStep("queued");
    setProgress(0);
    setMessage("Queued...");

    setLoading(true);
    setJobId(null);

    try {
      const res = await fetch(`${API_BASE}/generate-pod-design`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, num_designs: count }),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Generate failed (${res.status}): ${txt}`);
      }

      const data: GenerateResponse = await res.json();
      const jid = data.job_id ?? null;

      if (!jid) throw new Error("Backend did not return job_id");

      setJobId(jid);

      // IMPORTANT: do NOT setLoading(false) here.
      // We stay loading until status says done/error.
    } catch (e: any) {
      setLoading(false);
      setError(e?.message ?? "Unknown error");
      setStatus("error");
      setMessage("Failed");
      setProgress(100);
    }
  };

  const showProgressCard =
    loading || (jobId && status !== "idle" && status !== "done" && status !== "error");

  return (
    <div className="page">
      <div className="page-wrapper">

        {/* FULL WIDTH HERO SECTION */}
        <div className="hero">
          <h1 className="title hero-title">
            <span style={{ display: "block", fontSize: "1.2em", marginBottom: "8px" }}>Bulk Tshirt Designer</span>
            <span style={{ fontSize: "0.6em", fontWeight: 600, color: "#cbd5e1", letterSpacing: "0.05em", textTransform: "uppercase" }}>For Print On Demand Business</span>
          </h1>
          <p className="subtitle hero-subtitle">
            Automate your POD workflow. Create an entire collection of print-ready designs and marketing assets from a single prompt.
          </p>

          <div style={{ marginTop: "40px", marginBottom: "16px", background: "rgba(167, 139, 250, 0.1)", border: "1px solid rgba(167, 139, 250, 0.2)", padding: "24px", borderRadius: "16px", display: "inline-block", maxWidth: "900px" }}>
            <h3 style={{ fontSize: "20px", fontWeight: 800, color: "#c4b5fd", marginBottom: "12px" }}>Your Complete POD Pipeline on Autopilot</h3>
            <p style={{ fontSize: "15px", lineHeight: "1.6", color: "rgba(255,255,255,0.85)", marginBottom: "16px", maxWidth: "700px", margin: "0 auto 16px auto" }}>
              Stop wasting hours jumping between AI tools, upscalers, background removers, and SEO text generators.
              <strong> Just type a design prompt, and we'll instantly generate your entire ready-to-sell collection:</strong>
            </p>

            <div className="pipeline-steps" style={{ marginTop: "24px" }}>
              <div className="step-badge">1. Enhance Prompt</div>
              <svg className="step-arrow" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              <div className="step-badge">2. Upscale Image</div>
              <svg className="step-arrow" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              <div className="step-badge">3. Remove Background</div>
              <svg className="step-arrow" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              <div className="step-badge">4. Generate Print Ready Files</div>
              <svg className="step-arrow" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              <div className="step-badge">5. Generate SEO Package</div>
            </div>
          </div>
        </div>

        <div className="container">

          {/* LEFT COLUMN: THE GENERATOR */}
          <div className="card" style={{ flex: 1, height: "fit-content" }}>

            <label style={{ fontWeight: 700, opacity: 0.9 }}>Design Description</label>
            <textarea
              className="textarea"
              placeholder='Example: "Cute astronaut panda, bold outlines, transparent background"'
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />

            <div style={{ marginTop: 8, marginBottom: 16, opacity: 0.7, fontSize: 13, paddingLeft: 4 }}>
              Enter a highly descriptive prompt above to get started. 🚀
            </div>

            <div className="sliderRow">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, opacity: 0.9 }}>
                <span style={{ fontWeight: 700 }}>Total Variations to Generate</span>
                <span style={{ fontWeight: "bold", color: "#a78bfa" }}>{count}</span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </div>

            <button className="generateBtn" disabled={!canGenerate} onClick={generateDesigns}>
              {loading ? "Working..." : "Generate POD Pipeline"}
            </button>

            {showProgressCard && (
              <div
                style={{
                  marginTop: 16,
                  padding: 14,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.06)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, opacity: 0.9 }}>
                  <span>{message || "Working..."}</span>
                  <span>{Math.max(0, Math.min(100, progress))}%</span>
                </div>

                <div
                  style={{
                    marginTop: 10,
                    height: 8,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.12)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: 8,
                      width: `${Math.max(0, Math.min(100, progress))}%`,
                      borderRadius: 999,
                      background: "linear-gradient(90deg, rgba(99,102,241,0.95), rgba(236,72,153,0.95))",
                      transition: "width 500ms ease",
                    }}
                  />
                </div>

                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
                  Step: {step || "starting"} {jobId ? `| Job: ${jobId}` : ""}
                </div>
              </div>
            )}

            {error && (
              <div style={{ marginTop: 16, padding: 12, borderRadius: 12, background: "rgba(239,68,68,0.15)" }}>
                <div style={{ color: "#fecaca", fontSize: 14 }}>{error}</div>
              </div>
            )}



            <div style={{ marginTop: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <h2 style={{ fontSize: 22, fontWeight: 900 }}>Generated Assets</h2>
                <div style={{ opacity: 0.65, fontSize: 14 }}>
                  {images.length > 0 ? `${images.length} images` : "Images will appear here"}
                </div>
              </div>

              {images.length === 0 ? (
                <div style={{ marginTop: 10, opacity: 0.5, fontSize: 13, fontStyle: "italic" }}>
                  Awaiting generation...
                </div>
              ) : (
                <div
                  style={{
                    marginTop: 14,
                    display: "grid",
                    gridTemplateColumns: "repeat(2, 1fr)",
                    gap: 12,
                  }}
                >
                  {images.map((img, idx) => (
                    <a
                      key={`${img}-${idx}`}
                      href={absolutize(img)}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        borderRadius: 16,
                        overflow: "hidden",
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.06)",
                        boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
                      }}
                    >
                      <img
                        src={absolutize(img)}
                        alt={labelFor(img)}
                        style={{ width: "100%", height: 220, objectFit: "cover", display: "block" }}
                        loading="lazy"
                      />
                      <div style={{ padding: 10, fontSize: 12, opacity: 0.85 }}>
                        {labelFor(img)}
                      </div>
                    </a>
                  ))}
                </div>
              )}

              {/* SEO DATA DISPLAY */}
              {!loading && seoData && (
                <div style={{ marginTop: 32 }}>
                  <h2 style={{ fontSize: 22, fontWeight: 900, marginBottom: 16 }}>SEO Listing Package</h2>
                  <div
                    style={{
                      padding: 24,
                      borderRadius: 16,
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,255,255,0.06)",
                      boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
                    }}
                  >
                    <div style={{ marginBottom: 20 }}>
                      <label style={{ display: "block", fontSize: 13, fontWeight: 700, opacity: 0.7, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", color: "#a78bfa" }}>
                        SEO Title
                      </label>
                      <div style={{ fontSize: 18, fontWeight: 600, color: "#f8fafc", background: "rgba(0,0,0,0.2)", padding: "12px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)" }}>
                        {seoData.title || "No title generated"}
                      </div>
                    </div>

                    <div style={{ marginBottom: 20 }}>
                      <label style={{ display: "block", fontSize: 13, fontWeight: 700, opacity: 0.7, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", color: "#a78bfa" }}>
                        SEO Description
                      </label>
                      <div style={{ fontSize: 15, lineHeight: 1.6, color: "#e2e8f0", background: "rgba(0,0,0,0.2)", padding: "12px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)", whiteSpace: "pre-wrap" }}>
                        {seoData.description || "No description generated"}
                      </div>
                    </div>

                    <div>
                      <label style={{ display: "block", fontSize: 13, fontWeight: 700, opacity: 0.7, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em", color: "#a78bfa" }}>
                        SEO Keywords (Comma-Separated)
                      </label>
                      <div style={{ fontSize: 14, color: "#cbd5e1", background: "rgba(0,0,0,0.2)", padding: "12px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)", wordBreak: "break-all" }}>
                        {seoData.keywords || "No keywords generated"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ZIP DOWNLOAD WRAPPER */}
              {!loading && (zipUrl || paymentRequired || images.length > 0) && (
                <div style={{ marginTop: 32 }} className="resultCard">
                  <div style={{ fontWeight: 800 }}>Designs Ready!</div>

                  {zipUrl && (
                    <a href={absolutize(zipUrl)} target="_blank" rel="noreferrer">
                      Download All Deliverables (ZIP)
                    </a>
                  )}
                  {paymentRequired && !zipUrl && (
                    <button
                      type="button"
                      onClick={handlePayToDownload}
                      disabled={payLoading}
                      style={{
                        marginTop: 8,
                        padding: "12px 24px",
                        background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                        color: "white",
                        border: "none",
                        borderRadius: 8,
                        fontWeight: 700,
                        cursor: payLoading ? "not-allowed" : "pointer",
                        opacity: payLoading ? 0.8 : 1,
                      }}
                    >
                      {payLoading ? "Redirecting…" : "Pay to download ZIP"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: DELIVERABLES HIGHLIGHT */}
          <div className="deliverablesCard" style={{ flex: 1, maxWidth: "560px", alignSelf: "flex-start" }}>
            <h2 style={{ fontSize: "28px", marginBottom: "8px", fontWeight: 800 }}>Print-On-Demand Deliverables</h2>
            <p style={{ opacity: 0.7, marginBottom: "20px", fontSize: "15px" }}>
              Everything you need for a successful product launch, packaged into a single downloaded ZIP file.
            </p>

            <h3 className="section-title">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
              File Specifications
            </h3>
            <ul className="glass-list">
              <li><strong>Resolution:</strong> 4500 x 5400 pixels</li>
              <li><strong>DPI:</strong> 300 High Resolution</li>
              <li><strong>Color Profile:</strong> sRGB</li>
              <li><strong>Format:</strong> PNG with transparent background</li>
            </ul>

            <h3 className="section-title">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
              Print File
            </h3>
            <ul className="glass-list">
              <li><code>print_ready.png</code> → Universal high-contrast print file optimized for any color garment (light or dark).</li>
            </ul>

            <h3 className="section-title" style={{ color: "#f87171" }}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
              Important Instructions
            </h3>
            <ul className="glass-list warning">
              <li>Do NOT add a background color before uploading to platforms like Merch by Amazon.</li>
              <li>This file is optimized with a thick outer outline to ensure perfect visibility on all colors.</li>
              <li>Optimized specifically for direct-to-garment (DTG) printing.</li>
            </ul>

            <h3 className="section-title">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
              Mockup
            </h3>
            <ul className="glass-list">
              <li>A premium blue shirt mockup is included for preview and marketing use (Instagram, Etsy, Pinterest).</li>
              <li>If uploading print files to platforms, DO NOT upload the mockup accidentally.</li>
            </ul>

            <h3 className="section-title">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
              Marketplace Text (SEO)
            </h3>
            <ul className="glass-list">
              <li><code>listing_bundle.txt</code> → Full copy-paste listing containing highly optimized Titles, Descriptions, Etsy Tags (Top 13), and SEO Keywords.</li>
              <li>Individual SEO components are also split into separate files.</li>
            </ul>
          </div>

        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-600 to-indigo-700">
        <div className="text-white text-xl">Loading...</div>
      </div>
    }>
      <HomeContent />
    </Suspense>
  );
}
