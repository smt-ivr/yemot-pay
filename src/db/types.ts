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

export interface Course {
  id: number;
  name: string;
  ivr_code: string | null;
  billing_type: BillingType;
  price: number;
  max_phones: number;
  is_active: number;
  /** תוקף הגישה בימים מיום התשלום. NULL = לצמיתות */
  access_days?: number | null;
}

export interface Product {
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
