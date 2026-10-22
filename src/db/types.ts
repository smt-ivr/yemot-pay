export type BillingType = "monthly" | "one_time";
export type ProductType = "product" | "meeting" | "phone_meeting";
export type SubscriptionStatus = "pending" | "active" | "paused" | "cancelled" | "failed";
export type OrderStatus = "pending" | "paid" | "scheduled" | "completed" | "cancelled" | "refunded";
export type PaymentStatus = "pending" | "success" | "failed" | "refunded";

export interface Customer {
  id: number;
  full_name: string | null;
  main_phone: string;
}

export interface Course extends ItemSettings {
  id: number;
  name: string;
  ivr_code: string | null;
  billing_type: BillingType;
  price: number;
  max_phones: number;
  is_active: number;
  /** תוקף הגישה בימים מיום התשלום. NULL = לצמיתות */
  access_days?: number | null;
  /** כשהקורס לא פעיל: keep = מי שרכש ממשיך לקבל גישה, block = נחסם */
  on_inactive?: "keep" | "block";
}

/** הגדרות משותפות לקורס ולמוצר: טקסטים משלו ומה קורה אחרי רכישה */
export interface ItemSettings {
  /** 1 = המתקשר יכול לבחור טלפון אחר במקום המספר שממנו התקשר */
  ask_phone?: number;
  /** טקסט הצעה משלו (ריק = הטקסט הכללי) */
  offer_text?: string | null;
  /** טקסט אחרי רכישה מוצלחת (ריק = הטקסט הכללי) */
  success_text?: string | null;
  /** 1 = לשלוח מייל אחרי רכישה (אם המיילים מופעלים בהגדרות הכלליות) */
  send_email?: number;
  /** נמענים נוספים רק לפריט הזה */
  email_to?: string | null;
  /** נושא / תוכן משלו (ריק = התבנית הכללית) */
  email_subject?: string | null;
  email_body?: string | null;
}

export interface Product extends ItemSettings {
  id: number;
  type: ProductType;
  name: string;
  ivr_code: string | null;
  price: number;
  duration_minutes: number | null;
  is_active: number;
}

export interface Subscription {
  id: number;
  customer_id: number;
  course_id: number;
  status: SubscriptionStatus;
  price: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  customer_id: number;
  product_id: number;
  amount: number;
  status: OrderStatus;
  contact_phone: string | null;
  created_at: string;
}
