import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, KeyRound, ShieldAlert, Star } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiDownload, apiFetch } from '../lib/api';
import type { Order, OrderDigitalAsset, OrderStatus } from '../types';

interface OrderDetailPayload {
  order: Order;
  items: Array<{
    id: string;
    product_id: string;
    product_title: string;
    listing_type: string;
    quantity: number;
    unit_price: number;
    currency: string;
  }>;
  history: Array<{
    id: string;
    old_status: string;
    new_status: string;
    changed_by_role: string;
    actor_name: string;
    note: string;
    created_at: string;
  }>;
  review: { id: string; rating: number; comment: string } | null;
}

export function OrdersPage({ initialOrderId }: { initialOrderId?: string }) {
  const { user, goBack, requireUserOrPrompt, notify } = useApp();
  const [roleFilter, setRoleFilter] = useState<'all' | 'buyer' | 'seller'>('all');
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialOrderId || null);
  const [detail, setDetail] = useState<OrderDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusNote, setStatusNote] = useState('');
  const [digitalAssets, setDigitalAssets] = useState<OrderDigitalAsset[]>([]);
  const [digitalLockedMsg, setDigitalLockedMsg] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Review state
  const [rating, setRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');

  const loadOrders = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ orders: Order[] }>(`/api/orders?role=${roleFilter}`);
      setOrders(res.orders);
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  }, [user, roleFilter]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await apiFetch<OrderDetailPayload>(`/api/orders/${id}`);
      setDetail(res);
      setDigitalAssets([]);
      setDigitalLockedMsg(null);
      const hasDigitalItem = res.items.some((item) => item.listing_type === 'digital');
      if (hasDigitalItem) {
        const isSeller = user?.id === res.order.seller_user_id;
        const unlocked = ['Confirmed', 'Processing', 'Shipped', 'Delivered', 'Completed'].includes(res.order.status);
        if (isSeller || unlocked) {
          try {
            const dig = await apiFetch<{ assets: OrderDigitalAsset[] }>(`/api/orders/${id}/digital`);
            setDigitalAssets(dig.assets || []);
          } catch (digErr) {
            setDigitalLockedMsg(digErr instanceof Error ? digErr.message : 'Digital package unavailable');
          }
        } else {
          setDigitalLockedMsg('Protected digital files and license keys unlock once the order is Confirmed.');
        }
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to load order', 'error');
    }
  }, [notify, user?.id]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    loadOrders();
  }, [user, loadOrders]);

  useEffect(() => {
    if (selectedId && user) {
      loadDetail(selectedId);
    }
  }, [selectedId, user, loadDetail]);

  if (!user) {
    return (
      <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
        <h1 className="text-lg font-semibold text-white">Direct Transaction Orders</h1>
        <p className="text-sm text-slate-400">Sign in with Telegram to view your orders and status history.</p>
        <button
          type="button"
          onClick={() => requireUserOrPrompt()}
          className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold"
        >
          Connect Account
        </button>
      </div>
    );
  }

  async function updateStatus(orderId: string, status: OrderStatus) {
    try {
      await apiFetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note: statusNote }),
      });
      setStatusNote('');
      notify(`Order updated to ${status}`, 'success');
      await loadDetail(orderId);
      await loadOrders();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Status update failed', 'error');
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    try {
      await apiFetch(`/api/orders/${detail.order.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ rating, comment: reviewComment }),
      });
      setReviewComment('');
      notify('Verified review published', 'success');
      await loadDetail(detail.order.id);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Review submission failed', 'error');
    }
  }

  async function handleDigitalDownload(orderId: string, asset: OrderDigitalAsset) {
    setDownloadingId(asset.productId);
    try {
      await apiDownload(
        `/api/orders/${orderId}/digital/${asset.productId}/download`,
        asset.fileName || 'digital-delivery.txt'
      );
      notify('Digital delivery downloaded', 'success');
      await loadDetail(orderId);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Download failed', 'error');
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="space-y-5 pb-12">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={goBack} className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white min-h-[44px]">
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0E1525] border border-slate-800">
          {(['all', 'buyer', 'seller'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRoleFilter(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${
                roleFilter === r ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {r === 'all' ? 'All Orders' : `As ${r}`}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 rounded-xl bg-[#0E1525] border border-slate-800 flex items-start gap-2.5 text-xs text-slate-300">
        <ShieldAlert className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <span>
          SOFUMER uses direct buyer-to-seller transactions. Payment and delivery terms are arranged
          directly between buyer and seller; seller-reported payment or dispatch is not independently verified by SOFUMER.
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Orders List */}
        <div className="lg:col-span-5 space-y-2.5">
          {loading ? (
            <div className="h-40 rounded-2xl bg-[#0E1525] border border-slate-800 animate-pulse" />
          ) : orders.length === 0 ? (
            <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 text-sm text-slate-400">
              No orders recorded yet. After negotiating with a seller in Messages, the seller records the agreed order for your confirmation.
            </div>
          ) : (
            orders.map((ord) => (
              <button
                key={ord.id}
                type="button"
                onClick={() => setSelectedId(ord.id)}
                className={`w-full p-4 rounded-2xl border text-left transition-colors ${
                  selectedId === ord.id
                    ? 'bg-blue-600/15 border-blue-500'
                    : 'bg-[#0E1525] border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-400 font-mono-nums">
                  <span>{ord.order_number}</span>
                  <span className="text-blue-400 font-medium">{ord.status}</span>
                </div>
                <div className="mt-1 text-sm font-semibold text-white truncate">
                  {ord.primary_item_title || ord.shop_name}
                </div>
                <div className="mt-1 flex justify-between text-xs text-slate-400">
                  <span>{ord.buyer_user_id === user.id ? `Seller: ${ord.shop_name}` : `Buyer: ${ord.buyer_name}`}</span>
                  <span className="font-mono-nums text-slate-200">
                    {ord.currency} {ord.agreed_total}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Order Detail & Lifecycle */}
        <div className="lg:col-span-7">
          {!detail ? (
            <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center text-sm text-slate-400">
              Select an order to view details, update status, or view audit history.
            </div>
          ) : (
            <div className="p-5 sm:p-6 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-800">
                <div>
                  <div className="text-xs text-slate-400 font-mono-nums">{detail.order.order_number}</div>
                  <h2 className="text-lg font-bold text-white mt-0.5">{detail.order.status}</h2>
                  <div className="text-xs text-slate-400 mt-1">
                    Shop: {detail.order.shop_name} · Buyer: {detail.order.buyer_name}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-white font-mono-nums">
                    {detail.order.currency} {detail.order.agreed_total}
                  </div>
                  <div className="text-xs text-slate-400">Direct Arrangement</div>
                </div>
              </div>

              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-slate-400">Payment Arrangement: </span>
                  <span className="text-slate-200">{detail.order.payment_arrangement}</span>
                </div>
                <div>
                  <span className="text-slate-400">Delivery Arrangement: </span>
                  <span className="text-slate-200">{detail.order.delivery_arrangement || 'Agreed directly'}</span>
                </div>
              </div>

              {(digitalAssets.length > 0 || digitalLockedMsg) && (
                <div className="p-4 rounded-xl bg-[#070B14] border border-emerald-800/50 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                    <KeyRound className="w-4 h-4" />
                    <span>Protected Digital Delivery</span>
                  </div>
                  {digitalLockedMsg ? (
                    <p className="text-xs text-slate-400">{digitalLockedMsg}</p>
                  ) : (
                    <div className="space-y-2.5">
                      {digitalAssets.map((asset) => (
                        <div key={asset.productId} className="p-3 rounded-lg bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-white">{asset.productTitle}</span>
                            <span className="text-slate-400 font-mono-nums">
                              Downloads: {asset.downloadsUsed}/{asset.downloadLimit}
                            </span>
                          </div>
                          {!asset.hasAsset ? (
                            <p className="text-slate-400">
                              The seller has not attached a digital package to this listing yet. Message the seller in Messages.
                            </p>
                          ) : (
                            <>
                              {asset.licenseKey && (
                                <div className="p-2 rounded bg-[#070B14] border border-slate-800 font-mono-nums text-emerald-300 break-all">
                                  License Key: {asset.licenseKey}
                                </div>
                              )}
                              {asset.deliveryInstructions && (
                                <p className="text-slate-300 whitespace-pre-line">{asset.deliveryInstructions}</p>
                              )}
                              <button
                                type="button"
                                disabled={downloadingId === asset.productId}
                                onClick={() => handleDigitalDownload(detail.order.id, asset)}
                                className="h-9 px-3.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>
                                  {downloadingId === asset.productId
                                    ? 'Downloading...'
                                    : asset.hasFile && asset.fileName
                                    ? `Download ${asset.fileName}`
                                    : 'Download Delivery Receipt'}
                                </span>
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Action Controls based on User Role & Current Status */}
              <div className="p-4 rounded-xl bg-[#070B14] border border-slate-800 space-y-3">
                <input
                  type="text"
                  value={statusNote}
                  onChange={(e) => setStatusNote(e.target.value)}
                  placeholder="Optional note for status update (tracking info, handoff notes)..."
                  className="w-full h-10 px-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white"
                />
                <div className="flex flex-wrap gap-2">
                  {detail.order.buyer_user_id === user.id && (
                    <>
                      {detail.order.status === 'Pending Confirmation' && (
                        <>
                          <button type="button" onClick={() => updateStatus(detail.order.id, 'Confirmed')} className="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                            Confirm Order Details
                          </button>
                          <button type="button" onClick={() => updateStatus(detail.order.id, 'Cancelled')} className="h-9 px-3.5 rounded-lg bg-slate-800 text-slate-200 text-xs">
                            Cancel
                          </button>
                        </>
                      )}
                      {['Shipped', 'Delivered'].includes(detail.order.status) && (
                        <button type="button" onClick={() => updateStatus(detail.order.id, 'Completed')} className="h-9 px-3.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Confirm Completion</span>
                        </button>
                      )}
                      {['Confirmed', 'Processing', 'Shipped', 'Delivered'].includes(detail.order.status) && (
                        <button type="button" onClick={() => updateStatus(detail.order.id, 'Disputed')} className="h-9 px-3.5 rounded-lg bg-red-900/60 border border-red-700/60 text-red-100 text-xs">
                          Report Dispute
                        </button>
                      )}
                    </>
                  )}

                  {detail.order.seller_user_id === user.id && (
                    <>
                      {detail.order.status === 'Confirmed' && (
                        <button type="button" onClick={() => updateStatus(detail.order.id, 'Processing')} className="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                          Mark Processing
                        </button>
                      )}
                      {['Confirmed', 'Processing'].includes(detail.order.status) && (
                        <button type="button" onClick={() => updateStatus(detail.order.id, 'Shipped')} className="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                          Mark Shipped / Dispatched
                        </button>
                      )}
                      {['Confirmed', 'Processing', 'Shipped'].includes(detail.order.status) && (
                        <button type="button" onClick={() => updateStatus(detail.order.id, 'Delivered')} className="h-9 px-3.5 rounded-lg bg-purple-600 text-white text-xs font-semibold">
                          Mark Delivered
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Verified Review Submission for Completed Orders */}
              {detail.order.status === 'Completed' && detail.order.buyer_user_id === user.id && !detail.review && (
                <form onSubmit={submitReview} className="p-4 rounded-xl bg-[#070B14] border border-blue-800/50 space-y-3">
                  <div className="text-xs font-semibold text-white">Submit Verified Transaction Review</div>
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setRating(n)}
                        className={`p-1.5 rounded-lg ${rating >= n ? 'text-amber-400' : 'text-slate-600'}`}
                      >
                        <Star className={`w-5 h-5 ${rating >= n ? 'fill-amber-400' : ''}`} />
                      </button>
                    ))}
                  </div>
                  <textarea
                    rows={2}
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder="Share your experience with this seller and product..."
                    className="w-full p-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white"
                  />
                  <button type="submit" className="h-9 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                    Publish Verified Review
                  </button>
                </form>
              )}

              {/* Status Audit History */}
              <div className="space-y-2.5 pt-2">
                <h3 className="text-xs font-semibold text-slate-300">Status History</h3>
                <div className="space-y-2">
                  {detail.history.map((h) => (
                    <div key={h.id} className="p-3 rounded-xl bg-[#070B14] border border-slate-800/80 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{h.new_status}</span>
                        <span className="text-slate-500 font-mono-nums">
                          {new Date(h.created_at + 'Z').toLocaleString()}
                        </span>
                      </div>
                      <div className="text-slate-400 mt-0.5">
                        By {h.actor_name} ({h.changed_by_role}) — {h.note}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
