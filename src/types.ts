export interface UserContext {
  id: number;
  fullName: string;
  email: string;
  branchId: number;
  roles: string[];
  permissions: string[];
}

export interface DemoAccount {
  full_name: string;
  email: string;
  specialty: string | null;
  role_code: string;
  role_name: string;
}

export interface Patient {
  id: number;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: 'Male' | 'Female' | 'Other';
  date_of_birth: string;
  phone: string;
  email: string | null;
  address: string | null;
  next_of_kin_name?: string | null;
  next_of_kin_phone?: string | null;
  blood_group?: string | null;
  allergies?: string | null;
  patient_type: 'self-pay' | 'insurance' | 'credit' | 'exempt';
  payer_name: string | null;
  insurance_number: string | null;
  status: string;
  created_at: string;
}

export interface QueueTicket {
  id: number;
  ticket_number: string;
  department: string;
  patient_id: number;
  visit_id: number | null;
  priority: 'emergency' | 'urgent' | 'routine';
  status: 'waiting' | 'called' | 'in_service' | 'completed' | 'skipped';
  notes: string | null;
  created_at: string;
  mrn: string;
  first_name: string;
  last_name: string;
  patient_type: string;
}

export interface Appointment {
  id: number;
  patient_id: number;
  doctor_id: number;
  appointment_date: string;
  start_time: string;
  end_time: string;
  visit_type: string;
  reason: string | null;
  status: 'scheduled' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';
  mrn: string;
  first_name: string;
  last_name: string;
  phone: string;
  patient_type: string;
  doctor_name: string;
  specialty: string | null;
}

export interface Visit {
  id: number;
  visit_number: string;
  patient_id: number;
  doctor_id: number | null;
  triage_priority: 'emergency' | 'urgent' | 'routine';
  chief_complaint: string | null;
  history_notes: string | null;
  exam_notes: string | null;
  diagnosis_code: string | null;
  diagnosis_text: string | null;
  treatment_plan: string | null;
  follow_up_date: string | null;
  status: 'triage' | 'in_consultation' | 'awaiting_results' | 'closed';
  reopen_reason: string | null;
  created_at: string;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: string;
  date_of_birth: string;
  allergies: string | null;
  blood_group: string | null;
  patient_type: string;
  doctor_name: string | null;
}

export interface VitalsRecord {
  id: number;
  visit_id: number;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  temperature: number | null;
  pulse: number | null;
  respiratory_rate: number | null;
  spo2: number | null;
  weight_kg: number | null;
  height_cm: number | null;
  bmi: number | null;
  blood_glucose: number | null;
  early_warning_flag: number;
  notes: string | null;
  recorded_at: string;
}

export interface LabOrder {
  id: number;
  visit_id: number;
  patient_id: number;
  test_code: string;
  test_name: string;
  sample_type: string;
  unit: string | null;
  reference_range: string | null;
  sample_barcode: string | null;
  result_value: string | null;
  previous_result_value: string | null;
  abnormal_flag: string | null;
  result_notes: string | null;
  rejection_reason: string | null;
  amend_reason: string | null;
  critical_ack_at: string | null;
  entered_by_name: string | null;
  verified_by_name: string | null;
  triage_priority: string | null;
  status: 'ordered' | 'collected' | 'resulted' | 'verified' | 'amended' | 'rejected';
  invoice_number: string | null;
  invoice_status: string | null;
  mrn: string;
  first_name: string;
  last_name: string;
  patient_type: string;
  created_at: string;
}

export interface ImagingCatalogItem {
  id: number;
  code: string;
  name: string;
  modality: string;
  body_region: string;
  price: number;
}

export interface ImagingOrder {
  id: number;
  visit_id: number;
  patient_id: number;
  catalog_id: number;
  exam_code: string;
  exam_name: string;
  modality: string;
  body_region: string;
  clinical_question: string | null;
  pregnancy_checked: number;
  exam_notes: string | null;
  findings: string | null;
  impression: string | null;
  addendum: string | null;
  status: 'ordered' | 'scheduled' | 'performed' | 'reported_draft' | 'reported_final';
  invoice_number: string | null;
  invoice_status: string | null;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: string;
  date_of_birth: string;
  patient_type: string;
  created_at: string;
}

export interface Ward {
  id: number;
  code: string;
  name: string;
  ward_type: string;
  daily_tariff: number;
}

export interface Bed {
  id: number;
  ward_id: number;
  bed_number: string;
  status: 'vacant' | 'reserved' | 'occupied' | 'cleaning' | 'out_of_service';
  ward_code: string;
  ward_name: string;
  daily_tariff: number;
  admission_id: number | null;
  admission_number: string | null;
  mrn: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface Admission {
  id: number;
  admission_number: string;
  patient_id: number;
  visit_id: number | null;
  ward_id: number;
  bed_id: number | null;
  admission_diagnosis: string;
  discharge_summary: string | null;
  discharge_cleared: number;
  status: 'ordered' | 'admitted' | 'discharge_ordered' | 'cleared' | 'discharged';
  admitted_at: string;
  discharged_at: string | null;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: string;
  allergies: string | null;
  ward_name: string;
  bed_number: string | null;
  doctor_name: string;
}

export interface MedicationAdministration {
  id: number;
  admission_id: number;
  patient_id: number;
  medicine_name: string;
  dose: string;
  scheduled_time: string;
  status: 'due' | 'given' | 'withheld' | 'missed';
  administered_by_name: string | null;
  administered_at: string | null;
  reason_not_given: string | null;
  mrn: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  bed_number: string | null;
}

export interface AppNotification {
  id: number;
  target_role: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  entity_type: string | null;
  entity_id: number | null;
  is_read: number;
  created_at: string;
}

export interface PrescriptionItem {
  id: number;
  medicine_id: number;
  code: string;
  generic_name: string;
  strength: string;
  form: string;
  dosage: string;
  frequency: string;
  duration_days: number;
  quantity: number;
  dispensed_qty: number;
  stock_qty: number;
  batch_number: string;
  expiry_date: string;
  instructions: string | null;
}

export interface Prescription {
  id: number;
  visit_id: number;
  patient_id: number;
  mrn: string;
  first_name: string;
  last_name: string;
  allergies: string | null;
  patient_type: string;
  doctor_name: string;
  invoice_number: string | null;
  invoice_status: string | null;
  status: 'pending' | 'dispensed' | 'cancelled';
  notes: string | null;
  created_at: string;
  items: PrescriptionItem[];
}

export interface InvoiceItem {
  id: number;
  service_code: string | null;
  description: string;
  category: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface PaymentRecord {
  id: number;
  amount: number;
  payment_method: string;
  reference_number: string | null;
  receipt_number: string | null;
  cashier_name: string | null;
  created_at: string;
}

export interface Invoice {
  id: number;
  invoice_number: string;
  patient_id: number;
  mrn: string;
  first_name: string;
  last_name: string;
  phone: string;
  payer_type: string;
  payer_name: string | null;
  subtotal: number;
  discount_amount: number;
  total_amount: number;
  paid_amount: number;
  status: 'unpaid' | 'partial' | 'paid' | 'credit_billed' | 'voided';
  notes: string | null;
  created_at: string;
  items: InvoiceItem[];
  payments: PaymentRecord[];
}

export interface CashierShift {
  id: number;
  cashier_id: number;
  cashier_name: string;
  opening_float: number;
  expected_cash: number;
  counted_cash: number | null;
  variance: number | null;
  status: 'open' | 'closed' | 'reconciled';
  opened_at: string;
  closed_at: string | null;
}

export interface ApprovalRequest {
  id: number;
  request_type: 'discount' | 'void_invoice' | 'refund' | 'reopen_visit';
  entity_type: string;
  entity_id: number;
  requested_amount: number | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: number;
  requested_by_name: string;
  decided_by: number | null;
  decided_by_name: string | null;
  decision_note: string | null;
  invoice_number: string | null;
  total_amount: number | null;
  first_name: string | null;
  last_name: string | null;
  mrn: string | null;
  created_at: string;
}

export interface AuditLog {
  id: number;
  occurred_at: string;
  user_id: number | null;
  user_name: string;
  role_at_time: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  patient_id: number | null;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  ip_address: string | null;
  prev_hash: string;
  row_hash: string;
}

