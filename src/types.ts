export interface Currency {
  code: string;
  name: string;
  symbol: string;
  usd_rate: number;
  decimal_places: number;
}

export interface Country {
  code: string;
  name: string;
  dial_code: string;
  default_currency: string;
  region: string;
  is_enabled: number;
  shipping_notes: string;
  verification_notes: string;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon_name: string;
  sort_order: number;
}

export interface Subcategory {
  id: string;
  category_id: string;
  slug: string;
  name: string;
  sort_order: number;
}

export interface SubscriptionPlan {
  id: string;
  code: 'FREE' | 'PRO' | 'BUSINESS';
  name: string;
  tagline: string;
  monthly_price: number;
  annual_price: number;
  currency: string;
  max_products: number;
  ai_daily_limit: number;
  featured_slots: number;
  promotional_discount_pct: number;
  analytics_level: string;
  custom_branding: number;
  priority_support: number;
  features_json: string;
}

export interface User {
  id: string;
  telegram_id: string;
  telegram_username: string;
  first_name: string;
  last_name: string;
  display_name: string;
  avatar_url: string;
  bio: string;
  phone: string;
  country_code: string;
  preferred_currency: string;
  preferred_language: string;
  status: string;
  roles: string[];
  isAdmin?: boolean;
  aiEnabled?: boolean;
}

export interface SellerProfile {
  id: string;
  user_id: string;
  seller_type: 'individual' | 'business';
  legal_name: string;
  business_registration_no: string;
  country_code: string;
  contact_email: string;
  contact_phone: string;
  contact_telegram: string;
  verification_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  status: 'active' | 'suspended';
}

export interface Shop {
  id: string;
  seller_id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  country_code: string;
  country_name?: string;
  logo_url: string;
  banner_url: string;
  return_policy: string;
  shipping_policy: string;
  default_currency: string;
  verification_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  is_featured: number;
  status: 'active' | 'suspended' | 'closed';
  rating_avg: number;
  review_count: number;
  product_count?: number;
}

export interface Product {
  id: string;
  shop_id: string;
  seller_user_id: string;
  category_id: string;
  subcategory_id: string | null;
  listing_type: 'physical' | 'digital' | 'service';
  title: string;
  slug: string;
  description: string;
  price: number;
  currency: string;
  condition: string;
  country_code: string;
  country_name?: string;
  location_text: string;
  shipping_info: string;
  international_shipping: number;
  file_format: string;
  digital_delivery_method: string;
  license_info: string;
  pricing_model: string;
  service_mode: string;
  delivery_timeframe: string;
  return_policy: string;
  keywords: string;
  faqs_json: string;
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
  moderation_notes?: string;
  is_featured: number;
  is_sponsored: number;
  view_count: number;
  favorite_count: number;
  inquiry_count: number;
  rating_avg: number;
  review_count: number;
  category_name?: string;
  subcategory_name?: string;
  shop_name?: string;
  shop_slug?: string;
  shop_logo?: string;
  shop_country?: string;
  shop_verification_status?: string;
  seller_name?: string;
  primary_image?: string | null;
  stock_quantity?: number;
  unlimited_digital?: number;
  availability_status?: string;
  created_at: string;
}

export interface Conversation {
  id: string;
  product_id: string | null;
  shop_id: string | null;
  subject: string;
  status: string;
  last_message_at: string;
  last_message_preview: string;
  unread_count: number;
  my_role: 'buyer' | 'seller';
  product_title?: string;
  product_price?: number;
  product_currency?: string;
  product_image?: string;
  shop_name?: string;
  shop_slug?: string;
  other_user_id: string;
  other_user_name: string;
  other_telegram_username: string;
  other_avatar_url: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_name?: string;
  body: string;
  attachment_url: string;
  attachment_type: string;
  message_type: 'text' | 'image' | 'order_proposal' | 'system';
  created_at: string;
}

export type OrderStatus =
  | 'Inquiry'
  | 'Pending Confirmation'
  | 'Confirmed'
  | 'Processing'
  | 'Shipped'
  | 'Delivered'
  | 'Completed'
  | 'Cancelled'
  | 'Disputed';

export interface Order {
  id: string;
  order_number: string;
  buyer_user_id: string;
  seller_user_id: string;
  shop_id: string;
  shop_name: string;
  shop_slug: string;
  buyer_name: string;
  seller_name: string;
  conversation_id: string | null;
  status: OrderStatus;
  agreed_total: number;
  currency: string;
  payment_arrangement: string;
  delivery_arrangement: string;
  seller_marked_paid: number;
  notes: string;
  primary_item_title?: string;
  has_review?: number;
  created_at: string;
  updated_at: string;
}

export type NavTab = 'home' | 'explore' | 'ai' | 'messages' | 'account';
export type SubView =
  | { type: 'tab'; tab: NavTab }
  | { type: 'product'; productId: string }
  | { type: 'shop'; slug: string }
  | { type: 'seller'; section?: string }
  | { type: 'orders'; orderId?: string }
  | { type: 'wishlist' }
  | { type: 'recently_viewed' }
  | { type: 'notifications' }
  | { type: 'support' }
  | { type: 'policies' }
  | { type: 'admin' };
