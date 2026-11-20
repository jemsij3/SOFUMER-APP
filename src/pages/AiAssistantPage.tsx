import { useEffect, useState } from 'react';
import { Bot, GitCompare, HelpCircle, PenTool, Send } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Product } from '../types';
import { ProductCard } from '../components/ProductCard';

interface AiStatus {
  allowed: boolean;
  reason?: string | null;
  dailyLimit: number;
  usedToday: number;
}

export function AiAssistantPage() {
  const { user, aiInitialPrompt, setAiInitialPrompt, requireUserOrPrompt, notify } = useApp();

  const [mode, setMode] = useState<'buyer' | 'compare' | 'seller' | 'support'>('buyer');
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [prompt, setPrompt] = useState(aiInitialPrompt || '');
  const [busy, setBusy] = useState(false);

  // Buyer search result
  const [buyerAnswer, setBuyerAnswer] = useState('');
  const [matchedProducts, setMatchedProducts] = useState<Product[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);

  // Compare mode
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareResult, setCompareResult] = useState('');

  // Seller AI mode
  const [sellerTitle, setSellerTitle] = useState('');
  const [sellerNotes, setSellerNotes] = useState('');
  const [sellerType, setSellerType] = useState<'physical' | 'digital' | 'service'>('physical');
  const [targetLang, setTargetLang] = useState('French');
  const [sellerDraft, setSellerDraft] = useState<Record<string, unknown> | null>(null);

  // Platform support mode
  const [supportReply, setSupportReply] = useState('');

  useEffect(() => {
    if (aiInitialPrompt) {
      setPrompt(aiInitialPrompt);
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
        .then((res) => setAvailableProducts(res.items || []))
        .catch(() => {});
    }
  }, [mode, availableProducts.length]);

  async function runBuyerSearch(customPrompt?: string) {
    if (!requireUserOrPrompt()) return;
    const q = (customPrompt ?? prompt).trim();
    if (!q) return;
    setBusy(true);
    try {
      const res = await apiFetch<{
        answer: string;
        matchedProducts: Product[];
        suggestedFollowUps: string[];
      }>('/api/ai/buyer/discover', {
        method: 'POST',
        body: JSON.stringify({ query: q }),
      });
      setBuyerAnswer(res.answer);
      setMatchedProducts(res.matchedProducts || []);
      setFollowUps(res.suggestedFollowUps || []);
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      notify(err instanceof Error ? err.message : 'AI request failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runCompare() {
    if (!requireUserOrPrompt()) return;
    if (compareIds.length < 2) {
      notify('Select at least 2 listings to compare.', 'info');
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ comparison: string }>('/api/ai/buyer/compare', {
        method: 'POST',
        body: JSON.stringify({ productIds: compareIds, focusQuestion: prompt }),
      });
      setCompareResult(res.comparison);
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Comparison failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runSellerAssist(action: 'generate_listing' | 'translate' | 'analytics') {
    if (!requireUserOrPrompt()) return;
    setBusy(true);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/ai/seller/assist', {
        method: 'POST',
        body: JSON.stringify({
          action,
          title: sellerTitle,
          notes: sellerNotes,
          listingType: sellerType,
          targetLanguage: targetLang,
        }),
      });
      setSellerDraft(res);
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Seller AI failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runSupport() {
    if (!requireUserOrPrompt()) return;
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ reply: string }>('/api/ai/platform/support', {
        method: 'POST',
        body: JSON.stringify({ question: prompt }),
      });
      setSupportReply(res.reply);
      apiFetch<AiStatus>('/api/ai/status').then(setStatus).catch(() => {});
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Support AI failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">SOFUMER AI Assistant</h1>
          <p className="text-xs text-slate-400">
            Grounded strictly in real published SOFUMER listings, sellers, and platform policies.
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
          onClick={() => setMode('buyer')}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'buyer' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <Bot className="w-4 h-4" />
          <span>Shopping Discovery</span>
        </button>
        <button
          type="button"
          onClick={() => setMode('compare')}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'compare' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <GitCompare className="w-4 h-4" />
          <span>Compare Listings</span>
        </button>
        <button
          type="button"
          onClick={() => setMode('seller')}
          className={`h-10 px-4 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 ${
            mode === 'seller' ? 'bg-blue-600 text-white' : 'bg-[#0E1525] border border-slate-800 text-slate-300'
          }`}
        >
          <PenTool className="w-4 h-4" />
          <span>Seller Tools</span>
        </button>
        <button
          type="button"
          onClick={() => setMode('support')}
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

      {mode === 'buyer' && (
        <div className="space-y-5">
          <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
            <label className="block text-sm font-medium text-white">
              Natural-Language Marketplace Search
            </label>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
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
                <Send className="w-4 h-4" />
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
                  onClick={() => {
                    setPrompt(example);
                    runBuyerSearch(example);
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-[#070B14] border border-slate-800 text-slate-300 hover:border-slate-700"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          {buyerAnswer && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-purple-700/40 space-y-4">
              <div className="text-xs font-medium text-purple-300">SOFUMER AI Response</div>
              <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{buyerAnswer}</p>
              {followUps.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
                  {followUps.map((f, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setPrompt(f);
                        runBuyerSearch(f);
                      }}
                      className="text-xs px-3 py-1.5 rounded-lg bg-[#070B14] border border-slate-800 text-blue-300 hover:border-blue-500/50"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {matchedProducts.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-base font-semibold text-white">Matching Published Listings</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
                {matchedProducts.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </div>
          )}
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
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Optional comparison focus (e.g. shipping speed, license terms)"
                className="flex-1 h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
              <button
                type="button"
                onClick={runCompare}
                disabled={busy || compareIds.length < 2}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                {busy ? 'Comparing...' : `Compare (${compareIds.length})`}
              </button>
            </div>
          </div>

          {compareResult && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 text-sm text-slate-200 whitespace-pre-line leading-relaxed">
              {compareResult}
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
                className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
              >
                Generate Title, Description, Keywords & FAQs
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
                  className="h-10 px-4 rounded-xl bg-[#131C31] border border-slate-700 text-slate-200 text-xs font-medium"
                >
                  Translate Listing
                </button>
              </div>
              <button
                type="button"
                onClick={() => runSellerAssist('analytics')}
                disabled={busy}
                className="h-10 px-4 rounded-xl bg-[#131C31] border border-purple-700/40 text-purple-200 text-xs font-medium"
              >
                Explain My Shop Analytics
              </button>
            </div>
          </div>

          {sellerDraft && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3 text-sm text-slate-200">
              <div className="text-xs font-medium text-blue-400">Draft Output (Review Before Publishing)</div>
              <pre className="whitespace-pre-wrap text-xs bg-[#070B14] p-4 rounded-xl border border-slate-800 overflow-x-auto">
                {JSON.stringify(sellerDraft, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {mode === 'support' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
            <label className="block text-sm font-medium text-white">
              Ask about SOFUMER Direct Transactions, Seller Plans, or Safety
            </label>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSupport()}
                placeholder="How do direct buyer-to-seller orders and confirmations work?"
                className="flex-1 h-11 px-4 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
              <button
                type="button"
                onClick={runSupport}
                disabled={busy}
                className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold"
              >
                {busy ? 'Thinking...' : 'Ask Support AI'}
              </button>
            </div>
          </div>
          {supportReply && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 text-sm text-slate-200 whitespace-pre-line leading-relaxed">
              {supportReply}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
