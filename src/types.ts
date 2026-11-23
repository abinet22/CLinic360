export interface UserContext {
  id: number;
  fullName: string;
  email: string;
  branchId: number;
  roles: string[];
  permissions: string[];
  mustChangePassword?: boolean;
  twoFaEnabled?: boolean;
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
  national_id?: string | null;
  dob_estimated?: number;
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
  visit_number?: string | null;
  specialty?: string | null;
  workflow_stage?: string | null;
  doctor_name?: string | null;
  consultation_invoice_id?: number | null;
  consultation_invoice_number?: string | null;
  consultation_invoice_status?: string | null;
  consultation_total_amount?: number | null;
  consultation_paid_amount?: number | null;
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
  appointment_id?: number | null;
  visit_type?: string | null;
  specialty?: string | null;
  consultation_invoice_id?: number | null;
  consultation_invoice_number?: string | null;
  consultation_invoice_status?: string | null;
  consultation_cleared?: boolean;
  workflow_stage?:
    | 'awaiting_payment'
    | 'paid_awaiting_vitals'
    | 'ready_for_doctor'
    | 'in_consultation'
    | 'awaiting_diagnostics'
    | 'results_ready'
    | 'awaiting_pharmacy'
    | 'completed'
    | string;
  results_ready?: boolean;
  vitals_count?: number;
  pending_lab_count?: number;
  verified_lab_count?: number;
  pending_imaging_count?: number;
  final_imaging_count?: number;
  rx_count?: number;
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
  corrected_of_id?: number | null;
  correction_reason?: string | null;
}

export interface LabAnalyteTemplate {
  code: string;
  name: string;
  unit: string;
  refRange: string;
}

export interface LabPanelResultItem {
  code?: string;
  analyte: string;
  value: string;
  unit: string;
  refRange: string;
  reference_range?: string;
  flag: 'normal' | 'high' | 'low' | 'critical';
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
  analyte_template_json?: string | null;
  panel_results_json?: string | null;
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

export interface ImagingAttachment {
  id: number;
  imaging_order_id: number;
  file_name: string;
  mime_type: string;
  data_url: string;
  caption: string | null;
  uploaded_by_name?: string | null;
  created_at: string;
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
  attachment_count?: number;
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
  bed_days_billed?: number;
  last_bed_billed_at?: string | null;
  daily_tariff?: number;
  days_stayed?: number;
  unbilled_days?: number;
  unbilled_bed_estimate?: number;
  deposit_balance?: number;
  outstanding_invoices?: number;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: string;
  patient_type?: string;
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

export interface FefoBatchOption {
  id: number;
  batch_number: string;
  expiry_date: string;
  qty_on_hand: number;
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
  selected_qty?: number | null;
  external_qty?: number | null;
  unit_price?: number;
  dispensed_qty: number;
  stock_qty: number;
  batch_number: string;
  expiry_date: string;
  instructions: string | null;
  store_item_id?: number | null;
  fefo_batches?: FefoBatchOption[];
}

export interface Prescription {
  id: number;
  visit_id: number;
  visit_number?: string | null;
  workflow_stage?: string | null;
  visit_status?: string | null;
  patient_id: number;
  mrn: string;
  first_name: string;
  last_name: string;
  allergies: string | null;
  patient_type: string;
  doctor_name: string;
  invoice_id?: number | null;
  invoice_number: string | null;
  invoice_status: string | null;
  status:
    | 'awaiting_stock_check'
    | 'pending_payment'
    | 'paid_ready_to_dispense'
    | 'pending'
    | 'partial'
    | 'dispensed'
    | 'cancelled';
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
  request_type: 'discount' | 'void_invoice' | 'refund' | 'reopen_visit' | 'discharge_override' | 'payer_exempt';
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
  admission_number?: string | null;
  total_amount: number | null;
  first_name: string | null;
  last_name: string | null;
  mrn: string | null;
  created_at: string;
}

export interface PaymentGateBypass {
  id: number;
  visit_id: number;
  patient_id: number;
  entity_type: 'lab' | 'imaging' | 'prescription' | string;
  entity_id: number;
  reason: string;
  set_by: number;
  set_by_name?: string | null;
  follow_up_status: 'pending_billing' | 'resolved';
  resolved_by?: number | null;
  resolved_by_name?: string | null;
  resolved_at?: string | null;
  resolution_note?: string | null;
  created_at: string;
  mrn?: string;
  first_name?: string;
  last_name?: string;
  visit_number?: string;
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

export interface StoreItem {
  id: number;
  code: string;
  name: string;
  category: 'medicine' | 'reagent' | 'consumable';
  unit: string;
  reorder_level: number;
  medicine_id: number | null;
  main_store_qty: number;
  dispensary_qty: number;
  lab_qty: number;
  total_qty: number;
  earliest_expiry: string | null;
}

export interface StockBatch {
  id: number;
  item_id: number;
  item_code: string;
  item_name: string;
  unit: string;
  category: string;
  location: 'main_store' | 'dispensary' | 'lab' | 'ward';
  batch_number: string;
  expiry_date: string;
  qty_on_hand: number;
  unit_cost: number;
  status: 'active' | 'depleted' | 'blocked_expired';
  block_reason: string | null;
  received_at: string;
}

export interface ExpiryAlert extends StockBatch {
  alert_band: 'expired' | 'critical_30d' | 'warning_90d';
}

export interface GoodsReceipt {
  id: number;
  grn_number: string;
  supplier_name: string;
  invoice_ref: string | null;
  total_cost: number;
  notes: string | null;
  received_by_name: string | null;
  received_at: string;
}

export interface StockRequisitionItem {
  id: number;
  requisition_id: number;
  item_id: number;
  item_code: string;
  item_name: string;
  unit: string;
  requested_qty: number;
  issued_qty: number;
}

export interface StockRequisition {
  id: number;
  req_number: string;
  from_location: string;
  to_location: 'dispensary' | 'lab' | 'ward';
  status: 'pending' | 'issued' | 'cancelled';
  notes: string | null;
  requested_by_name: string | null;
  issued_by_name: string | null;
  requested_at: string;
  issued_at: string | null;
  items: StockRequisitionItem[];
}

export interface PatientDeposit {
  id: number;
  deposit_number: string;
  patient_id: number;
  admission_id: number | null;
  admission_number: string | null;
  mrn: string;
  first_name: string;
  last_name: string;
  amount: number;
  remaining_amount: number;
  payment_method: string;
  reference_number: string | null;
  status: 'active' | 'applied' | 'refunded';
  collected_by_name: string | null;
  created_at: string;
}

export interface MedicationOrder {
  id: number;
  admission_id: number;
  patient_id: number;
  medicine_id: number | null;
  medicine_name: string;
  dose: string;
  route: string;
  frequency: 'OD' | 'BID' | 'TID' | 'QID' | 'STAT' | 'PRN' | string;
  prn: number;
  status: 'active' | 'stopped' | 'completed' | string;
  ordered_by_name?: string | null;
  created_at: string;
}

export interface WardRound {
  id: number;
  admission_id: number;
  patient_id: number;
  doctor_id: number;
  doctor_name?: string | null;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  recorded_at: string;
}

export interface NursingNote {
  id: number;
  admission_id: number;
  patient_id: number;
  nurse_id: number;
  nurse_name?: string | null;
  note_type: string;
  note: string;
  recorded_at: string;
}

export interface IpdVitalRecord {
  id: number;
  admission_id: number | null;
  visit_id?: number | null;
  patient_id: number;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  pulse?: number | null;
  heart_rate?: number | null;
  respiratory_rate: number | null;
  temperature?: number | null;
  temperature_c?: number | null;
  spo2: number | null;
  weight_kg: number | null;
  height_cm: number | null;
  bmi?: number | null;
  early_warning_flag?: number;
  notes: string | null;
  recorded_by_name?: string | null;
  recorded_at: string;
}

export interface IpdStatement {
  admission: Admission & {
    date_of_birth?: string;
    phone?: string;
    payer_name?: string | null;
  };
  invoices: Invoice[];
  deposits: PatientDeposit[];
  marHistory: MedicationAdministration[];
  medicationOrders?: MedicationOrder[];
  wardRounds?: WardRound[];
  nursingNotes?: NursingNote[];
  vitals?: IpdVitalRecord[];
}

export interface DoctorBlock {
  id: number;
  doctor_id: number;
  doctor_name: string;
  specialty: string | null;
  block_date: string;
  start_time: string;
  end_time: string;
  block_type: 'leave' | 'off_duty' | 'surgery' | 'unavailable';
  reason: string | null;
}

export interface ServiceItem {
  id: number;
  code: string;
  name: string;
  category: string;
  unit_price: number;
  active: number;
}

export interface NursingProcedure {
  id: number;
  visit_id: number;
  patient_id: number;
  service_id: number;
  service_code: string;
  service_name: string;
  unit_price?: number;
  invoice_id: number | null;
  invoice_number: string | null;
  invoice_status: string | null;
  ordered_by_name: string | null;
  performed_by_name: string | null;
  notes: string | null;
  status: 'ordered' | 'completed';
  performed_at: string | null;
  created_at: string;
}

export interface ChartAccount {
  id: number;
  code: string;
  name: string;
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal_balance: 'debit' | 'credit';
  active: number;
  debit_total?: number;
  credit_total?: number;
  net_balance?: number;
}

export interface JournalLine {
  entry_id: number;
  account_id: number;
  code: string;
  name: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface AccountingPeriod {
  id: number;
  period_code: string;
  status: 'open' | 'closed';
  closed_by?: number | null;
  closed_by_name?: string | null;
  closed_at?: string | null;
}

export interface JournalEntry {
  id: number;
  entry_number: string;
  entry_date: string;
  source_type: string;
  source_id: number | null;
  reversal_of_id?: number | null;
  description: string;
  total_debit: number;
  total_credit: number;
  posted_by_name: string | null;
  created_at: string;
  lines: JournalLine[];
}

export interface SupplierBill {
  id: number;
  bill_number: string;
  grn_id: number | null;
  grn_number: string | null;
  supplier_name: string;
  invoice_ref: string | null;
  bill_date: string;
  due_date: string;
  total_amount: number;
  paid_amount: number;
  status: 'open' | 'partial' | 'paid';
  notes: string | null;
}

export interface ExpenseVoucher {
  id: number;
  voucher_number: string;
  expense_date: string;
  category: string;
  account_id: number;
  account_code: string;
  account_name: string;
  payee_name: string;
  amount: number;
  payment_method: string;
  description: string;
  status: 'pending' | 'paid' | 'rejected';
  requested_by_name: string | null;
  approved_by_name: string | null;
  paid_at: string | null;
  journal_entry_number?: string | null;
}

export interface InsuranceClaim {
  id: number;
  claim_number: string;
  payer_name: string;
  invoice_id: number;
  invoice_number: string;
  patient_id: number;
  mrn: string;
  first_name: string;
  last_name: string;
  billed_amount: number;
  settled_amount: number;
  status: 'submitted' | 'partial' | 'settled' | 'rejected';
  submitted_at: string;
  settled_at: string | null;
  notes: string | null;
  age_days?: number;
  age_bucket?: string;
}

export interface StaffContract {
  id: number;
  user_id: number;
  employee_code: string;
  full_name: string;
  email: string;
  specialty: string | null;
  role_code: string;
  role_name: string;
  department_name: string;
  contract_type: 'full_time' | 'part_time' | 'locum';
  base_salary: number;
  housing_allowance: number;
  licence_number: string | null;
  licence_expiry: string | null;
  licence_days_remaining?: number | null;
  licence_alert?: 'none' | 'expired' | 'expiring_soon' | 'valid';
  contract_start: string;
  status: string;
}

export interface LeaveRequest {
  id: number;
  user_id: number;
  staff_name: string;
  role_code: string;
  leave_type: 'annual' | 'sick' | 'study' | 'emergency';
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by_name: string | null;
  created_at: string;
}

export interface PayrollItem {
  id: number;
  payroll_run_id: number;
  user_id: number;
  staff_name: string;
  role_code: string;
  base_salary: number;
  allowances: number;
  taxable_allowances?: number;
  pension_employee?: number;
  pension_employer?: number;
  paye_tax?: number;
  tax_deduction: number;
  net_pay: number;
}

export interface PayrollRun {
  id: number;
  run_number: string;
  pay_month: string;
  total_gross: number;
  total_deductions: number;
  total_net: number;
  status: 'draft' | 'verified' | 'approved' | 'posted' | 'paid';
  journal_entry_id: number | null;
  journal_entry_number: string | null;
  payment_journal_entry_number?: string | null;
  created_by_name: string | null;
  verified_by_name?: string | null;
  approved_by_name?: string | null;
  paid_by_name?: string | null;
  posted_at: string | null;
  paid_at?: string | null;
  items: PayrollItem[];
}

export interface StaffPayslip extends PayrollItem {
  run_number: string;
  pay_month: string;
  run_status: string;
  posted_at: string | null;
  paid_at: string | null;
}

export interface ClinicSettings {
  clinicName: string;
  currencyCode: string;
  currencySymbol: string;
  timezone: string;
  expenseAutoPostLimit?: number;
}



