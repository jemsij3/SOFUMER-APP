-- SOFUMER Migration 0002: System Configuration Seed (Zero Fake Products, Sellers, or Revenue)

-- Currencies
INSERT OR IGNORE INTO currencies (code, name, symbol, usd_rate, decimal_places) VALUES
  ('USD', 'US Dollar', '$', 1.0, 2),
  ('EUR', 'Euro', '€', 0.92, 2),
  ('GBP', 'British Pound', '£', 0.79, 2),
  ('CAD', 'Canadian Dollar', 'CA$', 1.39, 2),
  ('AUD', 'Australian Dollar', 'A$', 1.54, 2),
  ('JPY', 'Japanese Yen', '¥', 154.0, 0),
  ('AED', 'UAE Dirham', 'AED ', 3.67, 2),
  ('NGN', 'Nigerian Naira', '₦', 1620.0, 0),
  ('KES', 'Kenyan Shilling', 'KSh ', 129.0, 0),
  ('ZAR', 'South African Rand', 'R', 18.1, 2),
  ('ETB', 'Ethiopian Birr', 'ETB ', 124.0, 2),
  ('INR', 'Indian Rupee', '₹', 84.4, 2),
  ('SGD', 'Singapore Dollar', 'S$', 1.34, 2),
  ('BRL', 'Brazilian Real', 'R$', 5.8, 2);

-- Global Countries Directory
INSERT OR IGNORE INTO countries (code, name, dial_code, default_currency, region, is_enabled, shipping_notes, verification_notes) VALUES
  ('US', 'United States', '+1', 'USD', 'North America', 1, 'Domestic & international courier support arranged by seller.', 'Standard business or individual verification.'),
  ('GB', 'United Kingdom', '+44', 'GBP', 'Europe', 1, 'UK & EU cross-border shipping defined per listing.', 'Standard verification supported.'),
  ('DE', 'Germany', '+49', 'EUR', 'Europe', 1, 'EU single-market & international shipping.', 'Business VAT ID optional for pro verification.'),
  ('FR', 'France', '+33', 'EUR', 'Europe', 1, 'EU & international courier options.', 'Standard verification supported.'),
  ('CA', 'Canada', '+1', 'CAD', 'North America', 1, 'North American & worldwide dispatch.', 'Standard verification supported.'),
  ('AE', 'United Arab Emirates', '+971', 'AED', 'Middle East', 1, 'GCC & global air courier support.', 'Trade license supported for business shops.'),
  ('NG', 'Nigeria', '+234', 'NGN', 'Africa', 1, 'Regional logistics & international export by seller.', 'National ID or CAC registration supported.'),
  ('KE', 'Kenya', '+254', 'KES', 'Africa', 1, 'East African & international shipping.', 'Standard verification supported.'),
  ('ET', 'Ethiopia', '+251', 'ETB', 'Africa', 1, 'Local pickup & international air freight by agreement.', 'Business license or ID supported.'),
  ('ZA', 'South Africa', '+27', 'ZAR', 'Africa', 1, 'Domestic & global courier options.', 'Standard verification supported.'),
  ('SG', 'Singapore', '+65', 'SGD', 'Asia Pacific', 1, 'APAC & worldwide express shipping.', 'ACRA UEN supported for business accounts.'),
  ('JP', 'Japan', '+81', 'JPY', 'Asia Pacific', 1, 'International EMS & DHL/FedEx shipping.', 'Standard verification supported.'),
  ('IN', 'India', '+91', 'INR', 'Asia Pacific', 1, 'Domestic & export courier services.', 'GST/business verification optional.'),
  ('AU', 'Australia', '+61', 'AUD', 'Oceania', 1, 'Domestic & global air dispatch.', 'ABN optional for business sellers.'),
  ('BR', 'Brazil', '+55', 'BRL', 'South America', 1, 'Mercosur & international delivery terms per seller.', 'CPF/CNPJ verification optional.');

-- 10 Initial Marketplace Categories
INSERT OR IGNORE INTO categories (id, slug, name, description, icon_name, sort_order) VALUES
  ('cat_electronics', 'electronics', 'Electronics', 'Computers, phones, audio gear, components, and hardware.', 'Cpu', 1),
  ('cat_fashion', 'fashion', 'Fashion', 'Apparel, footwear, accessories, watches, and tailoring.', 'Shirt', 2),
  ('cat_home', 'home-and-living', 'Home and Living', 'Furniture, lighting, decor, kitchenware, and home essentials.', 'Home', 3),
  ('cat_beauty', 'beauty-and-personal-care', 'Beauty and Personal Care', 'Skincare, grooming, cosmetics, and wellness products.', 'Sparkles', 4),
  ('cat_sports', 'sports-and-fitness', 'Sports and Fitness', 'Equipment, athletic apparel, outdoor gear, and recovery.', 'Dumbbell', 5),
  ('cat_vehicles', 'vehicles-and-accessories', 'Vehicles and Accessories', 'Auto parts, EV accessories, motorcycles, and mobility gear.', 'Car', 6),
  ('cat_digital', 'digital-products', 'Digital Products', 'Templates, e-books, design assets, datasets, and media packs.', 'FileCode', 7),
  ('cat_software', 'software', 'Software', 'SaaS licenses, developer tools, plugins, scripts, and apps.', 'Terminal', 8),
  ('cat_services', 'professional-services', 'Professional Services', 'Engineering, design, consulting, legal, and business services.', 'Briefcase', 9),
  ('cat_other', 'other-products-and-services', 'Other Products and Services', 'Specialized goods, industrial supplies, and custom offerings.', 'Layers', 10);

-- Initial Subcategories
INSERT OR IGNORE INTO subcategories (id, category_id, slug, name, sort_order) VALUES
  ('sub_laptops', 'cat_electronics', 'laptops-workstations', 'Laptops & Workstations', 1),
  ('sub_phones', 'cat_electronics', 'smartphones-tablets', 'Smartphones & Tablets', 2),
  ('sub_audio', 'cat_electronics', 'audio-studio', 'Audio & Studio Gear', 3),
  ('sub_menswear', 'cat_fashion', 'menswear', 'Menswear', 1),
  ('sub_womenswear', 'cat_fashion', 'womenswear', 'Womenswear', 2),
  ('sub_footwear', 'cat_fashion', 'footwear-bags', 'Footwear & Bags', 3),
  ('sub_furniture', 'cat_home', 'furniture', 'Furniture & Lighting', 1),
  ('sub_kitchen', 'cat_home', 'kitchen-dining', 'Kitchen & Dining', 2),
  ('sub_skincare', 'cat_beauty', 'skincare', 'Skincare & Serums', 1),
  ('sub_fitness_eq', 'cat_sports', 'training-equipment', 'Training Equipment', 1),
  ('sub_auto_parts', 'cat_vehicles', 'parts-diagnostics', 'Parts & Diagnostics', 1),
  ('sub_ui_kits', 'cat_digital', 'design-templates', 'Design Kits & Templates', 1),
  ('sub_ebooks', 'cat_digital', 'guides-ebooks', 'Guides & E-Books', 2),
  ('sub_saas', 'cat_software', 'saas-licenses', 'SaaS & Tool Licenses', 1),
  ('sub_plugins', 'cat_software', 'scripts-plugins', 'Scripts & Plugins', 2),
  ('sub_dev', 'cat_services', 'software-engineering', 'Software Engineering', 1),
  ('sub_design', 'cat_services', 'brand-product-design', 'Brand & Product Design', 2),
  ('sub_consulting', 'cat_services', 'business-consulting', 'Business Consulting', 3),
  ('sub_custom', 'cat_other', 'custom-industrial', 'Custom & Industrial', 1);

-- Configurable Seller Subscription Plans (FREE, PRO, BUSINESS)
INSERT OR IGNORE INTO subscription_plans (
  id, code, name, tagline, monthly_price, annual_price, currency,
  max_products, ai_daily_limit, featured_slots, promotional_discount_pct,
  analytics_level, custom_branding, priority_support, features_json
) VALUES
  (
    'plan_free', 'FREE', 'Free Starter', 'For new individual sellers launching on SOFUMER',
    0, 0, 'USD', 10, 15, 0, 0, 'basic', 0, 0,
    '["Basic public storefront","Up to 10 active listings","Basic shop analytics","15 AI assistant actions per day","Direct buyer-seller messaging"]'
  ),
  (
    'plan_pro', 'PRO', 'Pro Seller', 'For active merchants scaling globally',
    29, 290, 'USD', 100, 100, 3, 15, 'advanced', 1, 0,
    '["Enhanced custom shop banner & branding","Up to 100 active listings","Advanced product & conversion analytics","100 AI assistant actions per day","3 featured slots & 15% promo discount"]'
  ),
  (
    'plan_business', 'BUSINESS', 'Business Enterprise', 'For multi-line brands and B2B exporters',
    89, 890, 'USD', 1000, 500, 12, 30, 'enterprise', 1, 1,
    '["Full storefront customization & priority badge review","Up to 1,000 active listings","Enterprise analytics & AI shop insights","500 AI assistant actions per day","12 featured slots & 30% promo discount"]'
  );

-- AI Feature Governance Settings
INSERT OR IGNORE INTO ai_feature_settings (id, feature_key, label, description, is_enabled, model_name, daily_limit_per_user) VALUES
  ('ai_global', 'global_ai', 'Global AI Engine', 'Master switch controlling all SOFUMER AI endpoints.', 1, '@cf/meta/llama-3.1-8b-instruct', 100),
  ('ai_buyer_search', 'buyer_search', 'AI Product & Shop Discovery', 'Natural-language search grounded strictly in published SOFUMER catalog records.', 1, '@cf/meta/llama-3.1-8b-instruct', 40),
  ('ai_buyer_compare', 'buyer_compare', 'AI Product Comparison', 'Side-by-side comparison of real SOFUMER listings.', 1, '@cf/meta/llama-3.1-8b-instruct', 25),
  ('ai_seller_listing', 'seller_listing', 'AI Seller Listing Writer', 'Generates title suggestions, descriptions, category picks, keywords, and FAQs for seller review.', 1, '@cf/meta/llama-3.1-8b-instruct', 40),
  ('ai_seller_translate', 'seller_translate', 'AI Listing Translation', 'Translates listing titles and descriptions for global buyers.', 1, '@cf/meta/llama-3.1-8b-instruct', 30),
  ('ai_seller_analytics', 'seller_analytics', 'AI Shop Analytics Insights', 'Explains real shop metrics and listing engagement.', 1, '@cf/meta/llama-3.1-8b-instruct', 20),
  ('ai_platform_support', 'platform_support', 'AI Platform Support & Trust', 'Explains SOFUMER rules, direct transactions, and assists flagging suspicious listings.', 1, '@cf/meta/llama-3.1-8b-instruct', 40);

-- Platform Governance Settings
INSERT OR IGNORE INTO platform_settings (key, value, value_type, description) VALUES
  ('seller_registration_enabled', 'true', 'boolean', 'Allow Telegram users to register seller profiles and shops'),
  ('product_submissions_enabled', 'true', 'boolean', 'Allow sellers to publish new product and service listings'),
  ('auto_approve_products', 'true', 'boolean', 'Publish compliant listings immediately or queue for manual moderation'),
  ('featured_product_price_7d', '15', 'number', 'Base price in USD for 7-day featured listing placement'),
  ('sponsored_placement_price_7d', '35', 'number', 'Base price in USD for 7-day sponsored top search placement'),
  ('banner_ad_price_7d', '75', 'number', 'Base price in USD for 7-day homepage promotional banner'),
  ('prohibited_keywords', 'counterfeit,stolen,illegal weapon,narcotic,scam', 'string', 'Comma-separated moderation keywords flagged on submission'),
  ('marketplace_announcement', '', 'string', 'Optional global announcement displayed to users');

-- Admin Roles & Permissions
INSERT OR IGNORE INTO admin_roles (id, code, name, description) VALUES
  ('role_owner', 'OWNER', 'Platform Owner', 'Full system, security, AI, monetization, and role governance'),
  ('role_mod', 'MODERATOR', 'Trust & Safety Moderator', 'Product moderation, abuse reports, messages investigation, and seller reviews'),
  ('role_ops', 'OPERATIONS', 'Marketplace Operations', 'Categories, countries, subscriptions, promotions, and support tickets');

INSERT OR IGNORE INTO admin_permissions (id, role_id, permission_key) VALUES
  ('perm_1', 'role_owner', '*'),
  ('perm_2', 'role_mod', 'moderation.manage'),
  ('perm_3', 'role_mod', 'reports.manage'),
  ('perm_4', 'role_mod', 'sellers.suspend'),
  ('perm_5', 'role_ops', 'catalog.manage'),
  ('perm_6', 'role_ops', 'monetization.manage'),
  ('perm_7', 'role_ops', 'support.manage');
