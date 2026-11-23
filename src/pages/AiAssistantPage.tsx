import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  GitCompare,
  HelpCircle,
  Loader2,
  PenTool,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { safeFaqList, safeStringArray, safeText } from '../lib/aiFormat';
import type { Product } from '../types';
import { ProductCard } from '../components/ProductCard';

interface AiStatus {
  allowed: boolean;
  reason?: string | null;
  dailyLimit: number;
  usedToday: number;
  modelName?: string;
}

interface BuyerTurn {
  id: string;
  question: string;
  answer: string;
  matchedProducts: Product[];
  suggestedFollowUps: string[];
  model?: string;
  createdAt: number;
}

interface SupportTurn {
  id: string;
  question: string;
  reply: string;
  model?: string;
  createdAt: number;
}

interface SellerDraftState {
  kind: 'generate_listing' | 'translate' | 'analytics';
  suggestedTitle?: string;
  improvedDescription?: string;
  suggestedCategoryId?: string;
  keywords?: string[];
  faqs?: Array<{ question: string; answer: string }>;
  translatedTitle?: string;
  translatedDescription?: string;
  targetLanguage?: string;
  insights?: string;
  stats?: Record<string, unknown>;
  model?: string;
}

function loadSessionHistory<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function AiAssistantPage() {
  const { user, categories, aiInitialPrompt, setAiInitialPrompt, requireUserOrPrompt, notify } = useApp();

  const [mode, setMode] = useState<'buyer' | 'compare' | 'seller' | 'support'>('buyer');
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [buyerPrompt, setBuyerPrompt] = useState(aiInitialPrompt || '');
  const [compareFocus, setCompareFocus] = useState('');
  const [supportPrompt, setSupportPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorState, setErrorState] = useState<{
    mode: 'buyer' | 'compare' | 'seller' | 'support';
    message: string;
    lastQuery?: string;
    lastSellerAction?: 'generate_listing' | 'translate' | 'analytics';
  } | null>(null);

  // Buyer discovery conversation turns
  const [buyerHistory, setBuyerHistory] = useState<BuyerTurn[]>([]);

  // Compare mode
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareResult, setCompareResult] = useState('');
  const [compareModel, setCompareModel] = useState('');

  // Seller AI mode
  const [sellerTitle, setSellerTitle] = useState('');
  const [sellerNotes, setSellerNotes] = useState('');
  const [sellerType, setSellerType] = useState<'physical' | 'digital' | 'service'>('physical');
  const [targetLang, setTargetLang] = useState('French');
  const [sellerDraft, setSellerDraft] = useState<SellerDraftState | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Platform support conversation turns
  const [supportHistory, setSupportHistory] = useState<SupportTurn[]>([]);

  const historyKey = user ? `sofumer_ai_session_v1_${user.id}` : '';

  useEffect(() => {
    if (!historyKey) return;
    const saved = loadSessionHistory<{
      buyerHistory?: BuyerTurn[];
      supportHistory?: SupportTurn[];
    }>(historyKey, {});
    if (Array.isArray(saved.buyerHistory)) setBuyerHistory(saved.buyerHistory.slice(-15));
    if (Array.isArray(saved.supportHistory)) setSupportHistory(saved.supportHistory.slice(-15));
  }, [historyKey]);

  useEffect(() => {
    if (!historyKey) return;
    try {
      sessionStorage.setItem(
        historyKey,
        JSON.stringify({
          buyerHistory: buyerHistory.slice(-15),
          supportHistory: supportHistory.slice(-15),
        })
      );
    } catch {
      // Ignore sessionStorage quota issues
    }
  }, [historyKey, buyerHistory, supportHistory]);

  useEffect(() => {
    if (aiInitialPrompt) {
      setMode('buyer');
      setBuyerPrompt(aiInitialPrompt);
      setAiInitialPrompt('');
    }
  }, [aiInitialPrompt, setAiInitialPrompt]);

  useEffect(() => {
    if (!user) return;
    apiFetch<AiStatus>('/api/ai/status')
      .then(setStatus)
      .catch(() => {});
  }, [user]);

  useEffect(() => {
    if (mode === 'compare' && availableProducts.length === 0) {
      apiFetch<{ items: Product[] }>('/api/marketplace/explore?mode=products')
        .then((res) => setAvailableProducts(Array.isArray(res.items) ? res.items : []))
        .catch(() => {});
    }
  }, [mode, availableProducts.length]);

  function copyText(field: string, value: string) {
    if (!value) return;
    navigator.clipboard?.writeText(value).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    }).catch(() => {});
  }

  async function runBuyerSearch(customPrompt?: string) {
    if (busy || !requireUserOrPrompt()) return;
    const q = safeText(customPrompt ?? buyerPrompt);
    if (!q) return;
    setErrorState(null);
    setBusy(true);
    try {
      const res = await apiFetch<{
        answer?: unknown;
        matchedProducts?: Product[];
        suggestedFollowUps?: unknown;
        model?: unknown;
      }>('/api/ai/buyer/discover', {
        method: 'POST',
        body: JSON.stringify({ query: q }),
      });
      const answer = safeText(
        res.answer,
        'I checked the published SOFUMER catalog but could not summarize a clear match. Try refining your keywords.'
      );
      const matchedProducts = Array.isArray(res.matchedProducts) ? res.matchedProducts : [];
      const suggestedFollowUps = safeStringArray(res.suggestedFollowUps, 3);
      const model = safeText(res.model);

      setBuyerHistory((prev) => [
        ...prev.slice(-14),
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          question: q,
          answer,
          matchedProducts,
          suggestedFollowUps,
          model: model || undefined,
          createdAt: Date.now(),
        },
      ]);
      setBuyerPrompt('');
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to reach AI shopping assistant right now.';
      setErrorState({ mode: 'buyer', message, lastQuery: q });
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runCompare() {
    if (busy || !requireUserOrPrompt()) return;
    if (compareIds.length < 2) {
      notify('Select at least 2 listings to compare.', 'info');
      return;
    }
    setErrorState(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ comparison?: unknown; model?: unknown }>('/api/ai/buyer/compare', {
        method: 'POST',
        body: JSON.stringify({ productIds: compareIds, focusQuestion: safeText(compareFocus) }),
      });
      setCompareResult(safeText(res.comparison, 'No comparison notes returned.'));
      setCompareModel(safeText(res.model));
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Comparison failed. Please try again.';
      setErrorState({ mode: 'compare', message });
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runSellerAssist(action: 'generate_listing' | 'translate' | 'analytics') {
    if (busy || !requireUserOrPrompt()) return;
    if (action !== 'analytics' && !safeText(sellerTitle) && !safeText(sellerNotes)) {
      notify('Enter a product title or notes first.', 'info');
      return;
    }
    setErrorState(null);
    setBusy(true);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/ai/seller/assist', {
        method: 'POST',
        body: JSON.stringify({
          action,
          title: safeText(sellerTitle),
          notes: safeText(sellerNotes),
          listingType: sellerType,
          targetLanguage: targetLang,
        }),
      });
      setSellerDraft({
        kind: action,
        suggestedTitle: safeText(res.suggestedTitle),
        improvedDescription: safeText(res.improvedDescription),
        suggestedCategoryId: safeText(res.suggestedCategoryId),
        keywords: safeStringArray(res.keywords, 12),
        faqs: safeFaqList(res.faqs),
        translatedTitle: safeText(res.translatedTitle),
        translatedDescription: safeText(res.translatedDescription),
        targetLanguage: safeText(res.targetLanguage, targetLang),
        insights: safeText(res.insights),
        stats:
          res.stats && typeof res.stats === 'object' && !Array.isArray(res.stats)
            ? (res.stats as Record<string, unknown>)
            : undefined,
        model: safeText(res.model),
      });
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Seller AI failed. Please try again.';
      setErrorState({ mode: 'seller', message, lastSellerAction: action });
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runSupport(customQuestion?: string) {
    if (busy || !requireUserOrPrompt()) return;
    const q = safeText(customQuestion ?? supportPrompt);
    if (!q) return;
    setErrorState(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ reply?: unknown; model?: unknown }>('/api/ai/platform/support', {
        method: 'POST',
        body: JSON.stringify({ question: q }),
      });
      const reply = safeText(res.reply, 'Support AI could not compose a reply. Please try rephrasing your question.');
      const model = safeText(res.model);
      setSupportHistory((prev) => [
        ...prev.slice(-14),
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          question: q,
          reply,
          model: model || undefined,
          createdAt: Date.now(),
        },
      ]);
      setSupportPrompt('');
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Support AI failed. Please try again.';
      setErrorState({ mode: 'support', message, lastQuery: q });
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const activeCategoryName = sellerDraft?.suggestedCategoryId
    ? categories.find((c) => c.id === sellerDraft.suggestedCategoryId)?.name || sellerDraft.suggestedCategoryId
    : '';

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">SOFUMER AI Assistant</h1>
          <p className="text-xs text-slate-400">
            Powered by Cloudflare Workers AI · Grounded strictly in real published SOFUMER listings, sellers, and platform policies.
          </p>
        </div>
        {status && (
          <div className="text-xs text-slate-300 font-mono-nums bg-[#0E1525] border border-slate-800 px-3.5 py-2 rounded-xl self-start">
            {status.allowed
              ? `Daily Quota: ${status.usedToday} / ${status.dailyLimit}`
              : status.reason || 'AI Restricted'}
          </div>
        )}
      </div>

      {/* Mode Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => {
            setErrorState(null);
            setMode('buyer');
          }}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'buyer' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <Bot className="w-4 h-4" />
          <span>Shopping Discovery</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setErrorState(null);
            setMode('compare');
          }}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'compare' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <GitCompare className="w-4 h-4" />
          <span>Compare Listings</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setErrorState(null);
            setMode('seller');
          }}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'seller' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <PenTool className="w-4 h-4" />
          <span>Seller Tools</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setErrorState(null);
            setMode('support');
          }}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'support' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <HelpCircle className="w-4 h-4" />
          <span>Platform Support</span>
        </button>
      </div>

      {!user && (
        <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-sm text-slate-300">
            Sign in with Telegram to run AI-powered marketplace discovery and seller tools.
          </div>
          <button
            type="button"
            onClick={() => requireUserOrPrompt()}
            className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold whitespace-nowrap shrink-0"
          >
            Connect Account
          </button>
        </div>
      )}

      {errorState && errorState.mode === mode && (
        <div className="p-4 rounded-2xl bg-red-950/40 border border-red-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-red-200">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorState.message}</span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (mode === 'buyer') runBuyerSearch(errorState.lastQuery);
              else if (mode === 'compare') runCompare();
              else if (mode === 'seller' && errorState.lastSellerAction) runSellerAssist(errorState.lastSellerAction);
              else if (mode === 'support') runSupport(errorState.lastQuery);
            }}
            className="h-8 px-3 rounded-lg bg-red-900/60 border border-red-700/70 text-xs text-red-100 inline-flex items-center gap-1.5 self-start sm:self-auto shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {mode === 'buyer' && (
        <div className="space-y-5">
          <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-sm font-medium text-white">
                Natural-Language Marketplace Search
              </label>
              {buyerHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBuyerHistory([])}
                  className="text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear chat</span>
                </button>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={buyerPrompt}
                onChange={(e) => setBuyerPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runBuyerSearch()}
                placeholder='e.g. "Find a laptop for programming under $700 with international shipping"'
                className="flex-1 h-11 px-4 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => runBuyerSearch()}
                disabled={busy}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                <span>{busy ? 'Searching...' : 'Ask AI'}</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {[
                'Find digital design kits or software licenses',
                'Show professional engineering or consulting services',
                'Find physical products with international shipping',
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBuyerPrompt(example);
                    runBuyerSearch(example);
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-[#070B14] border border-slate-800 text-slate-300 hover:border-slate-700 disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          {busy && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-blue-800/40 flex items-center gap-3 text-xs text-slate-300">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
              <span>Scanning published SOFUMER catalog with Cloudflare Workers AI...</span>
            </div>
          )}

          {[...buyerHistory].reverse().map((turn) => (
            <div key={turn.id} className="space-y-4">
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-purple-700/40 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium text-blue-300">
                    You asked: <span className="text-white">{turn.question}</span>
                  </div>
                  {turn.model && (
                    <span className="text-[11px] font-mono-nums text-slate-500">{turn.model}</span>
                  )}
                </div>
                <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{turn.answer}</p>
                {turn.suggestedFollowUps.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
                    {turn.suggestedFollowUps.map((f, i) => (
                      <button
                        key={i}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setBuyerPrompt(f);
                          runBuyerSearch(f);
                        }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-[#070B14] border border-slate-800 text-blue-300 hover:border-blue-500/50 disabled:opacity-50"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {turn.matchedProducts.length > 0 && (
                <div className="space-y-3">
                  <h2 className="text-base font-semibold text-white">Matching Published Listings</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
                    {turn.matchedProducts.map((p) => (
                      <ProductCard key={`${turn.id}_${p.id}`} product={p} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {mode === 'compare' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
            <div className="text-sm font-semibold text-white">Select 2 to 4 Published Listings to Compare</div>
            {availableProducts.length === 0 ? (
              <p className="text-xs text-slate-400">No published listings available in catalog yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-64 overflow-y-auto pr-1">
                {availableProducts.map((p) => {
                  const checked = compareIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        setCompareIds((prev) =>
                          prev.includes(p.id)
                            ? prev.filter((id) => id !== p.id)
                            : prev.length < 4
                            ? [...prev, p.id]
                            : prev
                        )
                      }
                      className={`p-3 rounded-xl border text-left transition-colors ${
                        checked
                          ? 'bg-blue-600/15 border-blue-500 text-white'
                          : 'bg-[#070B14] border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="text-xs font-semibold truncate">{p.title}</div>
                      <div className="text-[11px] text-slate-400 font-mono-nums mt-0.5">
                        {p.currency} {p.price} · {p.shop_name}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={compareFocus}
                onChange={(e) => setCompareFocus(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && compareIds.length >= 2 && runCompare()}
                placeholder="Optional comparison focus (e.g. shipping speed, license terms)"
                className="flex-1 h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
              <button
                type="button"
                onClick={runCompare}
                disabled={busy || compareIds.length < 2}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{busy ? 'Comparing...' : `Compare (${compareIds.length})`}</span>
              </button>
            </div>
          </div>

          {compareResult && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between text-xs text-blue-300">
                <span className="font-medium">Listing Comparison</span>
                {compareModel && <span className="font-mono-nums text-slate-500">{compareModel}</span>}
              </div>
              <div className="text-sm text-slate-200 whitespace-pre-line leading-relaxed">
                {compareResult}
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'seller' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
            <div className="text-sm font-semibold text-white">
              AI Listing Writer, Translator & Shop Analytics
            </div>
            <p className="text-xs text-slate-400">
              AI-generated drafts are for seller review before publishing. Nothing is published automatically.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                placeholder="Draft title or product concept"
                value={sellerTitle}
                onChange={(e) => setSellerTitle(e.target.value)}
                className="sm:col-span-2 h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
              <select
                value={sellerType}
                onChange={(e) => setSellerType(e.target.value as typeof sellerType)}
                className="h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              >
                <option value="physical">Physical Product</option>
                <option value="digital">Digital Product</option>
                <option value="service">Professional Service</option>
              </select>
            </div>
            <textarea
              rows={3}
              placeholder="Key specs, condition, shipping or delivery details..."
              value={sellerNotes}
              onChange={(e) => setSellerNotes(e.target.value)}
              className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            />
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => runSellerAssist('generate_listing')}
                disabled={busy}
                className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>Generate Title, Description, Keywords & FAQs</span>
              </button>
              <div className="flex items-center gap-1.5">
                <select
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white"
                >
                  <option>French</option>
                  <option>Spanish</option>
                  <option>Arabic</option>
                  <option>German</option>
                  <option>Swahili</option>
                </select>
                <button
                  type="button"
                  onClick={() => runSellerAssist('translate')}
                  disabled={busy}
                  className="h-10 px-4 rounded-xl bg-[#131C31] border border-slate-700 text-slate-200 text-xs font-medium disabled:opacity-60"
                >
                  Translate Listing
                </button>
              </div>
              <button
                type="button"
                onClick={() => runSellerAssist('analytics')}
                disabled={busy}
                className="h-10 px-4 rounded-xl bg-[#131C31] border border-purple-700/40 text-purple-200 text-xs font-medium disabled:opacity-60"
              >
                Explain My Shop Analytics
              </button>
            </div>
          </div>

          {sellerDraft && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4 text-sm text-slate-200">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-blue-400">
                  {sellerDraft.kind === 'translate'
                    ? `Translated Listing (${sellerDraft.targetLanguage || targetLang})`
                    : sellerDraft.kind === 'analytics'
                    ? 'Shop Performance Insights'
                    : 'Draft Output (Review Before Publishing)'}
                </span>
                {sellerDraft.model && <span className="font-mono-nums text-slate-500">{sellerDraft.model}</span>}
              </div>

              {sellerDraft.kind === 'generate_listing' && (
                <div className="space-y-3">
                  {sellerDraft.suggestedTitle && (
                    <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800 space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Suggested Title</span>
                        <button
                          type="button"
                          onClick={() => copyText('title', sellerDraft.suggestedTitle || '')}
                          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                        >
                          {copiedField === 'title' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedField === 'title' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                      <div className="font-semibold text-white">{sellerDraft.suggestedTitle}</div>
                    </div>
                  )}

                  {activeCategoryName && (
                    <div className="text-xs text-slate-400">
                      Suggested Category: <span className="text-slate-200 font-medium">{activeCategoryName}</span>
                    </div>
                  )}

                  {sellerDraft.improvedDescription && (
                    <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800 space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Improved Description</span>
                        <button
                          type="button"
                          onClick={() => copyText('desc', sellerDraft.improvedDescription || '')}
                          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                        >
                          {copiedField === 'desc' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedField === 'desc' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                      <p className="text-xs text-slate-200 whitespace-pre-line leading-relaxed">
                        {sellerDraft.improvedDescription}
                      </p>
                    </div>
                  )}

                  {sellerDraft.keywords && sellerDraft.keywords.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] text-slate-400">Search Keywords</div>
                      <div className="flex flex-wrap gap-1.5">
                        {sellerDraft.keywords.map((kw, idx) => (
                          <span key={idx} className="px-2.5 py-1 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-300">
                            {kw}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {sellerDraft.faqs && sellerDraft.faqs.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[11px] text-slate-400">Suggested Buyer FAQs</div>
                      {sellerDraft.faqs.map((faq, idx) => (
                        <div key={idx} className="p-3 rounded-xl bg-[#070B14] border border-slate-800 space-y-1 text-xs">
                          <div className="font-semibold text-white">{faq.question}</div>
                          <div className="text-slate-300">{faq.answer}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {sellerDraft.kind === 'translate' && (
                <div className="space-y-3">
                  {sellerDraft.translatedTitle && (
                    <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800 space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Translated Title</span>
                        <button
                          type="button"
                          onClick={() => copyText('trTitle', sellerDraft.translatedTitle || '')}
                          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                        >
                          {copiedField === 'trTitle' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedField === 'trTitle' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                      <div className="font-semibold text-white">{sellerDraft.translatedTitle}</div>
                    </div>
                  )}
                  {sellerDraft.translatedDescription && (
                    <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800 space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Translated Description</span>
                        <button
                          type="button"
                          onClick={() => copyText('trDesc', sellerDraft.translatedDescription || '')}
                          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                        >
                          {copiedField === 'trDesc' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedField === 'trDesc' ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                      <p className="text-xs text-slate-200 whitespace-pre-line leading-relaxed">
                        {sellerDraft.translatedDescription}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {sellerDraft.kind === 'analytics' && (
                <div className="p-4 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-200 whitespace-pre-line leading-relaxed">
                  {sellerDraft.insights || 'No analytics insights available.'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'support' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-sm font-medium text-white">
                Ask about SOFUMER Direct Transactions, Seller Plans, or Safety
              </label>
              {supportHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSupportHistory([])}
                  className="text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear chat</span>
                </button>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={supportPrompt}
                onChange={(e) => setSupportPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSupport()}
                placeholder="How do direct buyer-to-seller orders and confirmations work?"
                className="flex-1 h-11 px-4 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
              <button
                type="button"
                onClick={() => runSupport()}
                disabled={busy}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{busy ? 'Thinking...' : 'Ask Support AI'}</span>
              </button>
            </div>
          </div>

          {[...supportHistory].reverse().map((turn) => (
            <div key={turn.id} className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-blue-300 font-medium">{turn.question}</span>
                {turn.model && <span className="font-mono-nums text-slate-500">{turn.model}</span>}
              </div>
              <div className="text-sm text-slate-200 whitespace-pre-line leading-relaxed">{turn.reply}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

