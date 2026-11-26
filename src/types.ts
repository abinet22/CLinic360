export type DashboardType =
  | 'admin'
  | 'doctor'
  | 'nurse'
  | 'cashier'
  | 'lab'
  | 'radiology'
  | 'pharmacy'
  | 'hr'
  | 'accounting'
  | 'general';

export interface DepartmentInfo {
  id: number;
  code: string;
  name: string;
  category: string | null;
  isPrimary: boolean;
}

export interface ClinicUnitInfo {
  id: number;
  roomCode: string;
  name: string;
  departmentId: number | null;
  roomType: string | null;
}

export interface UserContext {
  id: number;
  employeeId?: number | null;
  username?: string | null;
  fullName: string;
  email: string;
  branchId: number;
  status?: string;
  roles: string[];
  permissions: string[];
  departmentIds?: number[];
  departmentCodes?: string[];
  departmentNames?: string[];
  departments?: DepartmentInfo[];
  clinicUnitIds?: number[];
  clinicUnits?: ClinicUnitInfo[];
  defaultDashboard?: DashboardType;
  authorizedDashboards?: DashboardType[];
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
  parent_id?: number | null;
  parent_code?: string | null;
  parent_name?: string | null;
  description?: string | null;
  tx_count?: number;
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
  paid_amount?: number;
  payment_method: string;
  cash_bank_account_id?: number | null;
  cash_bank_account_name?: string | null;
  reference_number?: string | null;
  attachment_ref?: string | null;
  description: string;
  status: 'pending' | 'approved' | 'partial' | 'paid' | 'rejected';
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

export interface HrEmployee {
  id: number;
  employee_number: string;
  user_id: number | null;
  user_email?: string | null;
  user_active?: number | null;
  role_code?: string | null;
  full_name: string;
  gender: 'male' | 'female' | 'other' | 'unspecified' | string;
  phone: string | null;
  email: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  department_name: string;
  job_position: string;
  employment_type: 'full_time' | 'part_time' | 'contract' | 'locum' | string;
  hire_date: string;
  contract_start: string;
  contract_end: string | null;
  basic_salary: number;
  housing_allowance: number;
  licence_number: string | null;
  licence_expiry: string | null;
  licence_days_remaining?: number | null;
  licence_alert?: 'none' | 'expired' | 'expiring_soon' | 'valid';
  status: 'active' | 'inactive' | 'resigned' | 'terminated';
  terminated_at: string | null;
  termination_reason: string | null;
  document_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface HrEmployeeDocument {
  id: number;
  employee_id: number;
  employee_number?: string;
  employee_name?: string;
  doc_type: 'contract' | 'certificate' | 'id_document' | 'licence' | 'other' | string;
  title: string;
  file_ref: string | null;
  expiry_date: string | null;
  notes: string | null;
  uploaded_by_name?: string | null;
  created_at: string;
}

export interface HrAttendanceRecord {
  id: number;
  employee_id: number;
  user_id: number | null;
  employee_number: string;
  full_name: string;
  department_name: string;
  attendance_date: string;
  check_in: string | null;
  check_out: string | null;
  hours_worked: number;
  status: 'present' | 'late' | 'early_departure' | 'absent' | 'on_leave';
  late_minutes: number;
  early_leave_minutes: number;
  notes: string | null;
}

export interface HrLeaveType {
  id: number;
  code: string;
  name: string;
  annual_allowance_days: number;
  paid: number;
  description: string | null;
  active: number;
}

export interface HrLeaveBalance {
  employee_id: number;
  employee_number: string;
  full_name: string;
  department_name: string;
  leave_type_code: string;
  leave_type_name: string;
  annual_allowance_days: number;
  used_days: number;
  pending_days: number;
  remaining_days: number;
}

export interface HrOvertimeRecord {
  id: number;
  employee_id: number;
  user_id: number | null;
  employee_number: string;
  full_name: string;
  department_name: string;
  overtime_date: string;
  hours: number;
  day_type: 'regular' | 'weekend' | 'holiday';
  rate_multiplier: number;
  hourly_rate_snapshot: number;
  computed_amount: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  payroll_run_id: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface HrAdjustment {
  id: number;
  employee_id: number;
  user_id: number | null;
  employee_number: string;
  full_name: string;
  department_name: string;
  adjustment_type: 'earning' | 'deduction';
  category: string;
  description: string;
  amount: number;
  effective_month: string;
  effective_date: string | null;
  recurring: number;
  status: 'active' | 'cancelled';
  created_by_name?: string | null;
  created_at: string;
}

export interface HrMonthlySubmission {
  id: number;
  pay_month: string;
  status: 'draft' | 'submitted' | 'processed';
  total_employees: number;
  total_attendance_hours: number;
  total_overtime_amount: number;
  total_extra_earnings: number;
  total_extra_deductions: number;
  notes: string | null;
  submitted_by_name: string | null;
  submitted_at: string;
}

export interface LeaveRequest {
  id: number;
  user_id: number | null;
  employee_id?: number | null;
  employee_number?: string | null;
  department_name?: string | null;
  staff_name: string;
  role_code: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by_name: string | null;
  decision_note?: string | null;
  created_at: string;
}

export interface PayrollComponent {
  id: number;
  code: string;
  name: string;
  component_type: 'earning' | 'deduction';
  calc_method: 'fixed' | 'percentage' | 'manual';
  default_value: number;
  account_code: string;
  is_recurring: number;
  is_taxable: number;
  is_pensionable: number;
  active: number;
}

export interface PayrollItem {
  id: number;
  payroll_run_id: number;
  user_id: number | null;
  employee_id?: number | null;
  staff_name: string;
  role_code: string;
  base_salary: number;
  allowances: number;
  taxable_allowances?: number;
  overtime_pay?: number;
  bonus_earnings?: number;
  pension_employee?: number;
  pension_employer?: number;
  paye_tax?: number;
  other_deductions?: number;
  tax_deduction: number;
  net_pay: number;
  paid_amount?: number;
  payment_status?: 'unpaid' | 'partial' | 'paid';
  payment_method?: string | null;
  payment_ref?: string | null;
  paid_at?: string | null;
}

export interface PayrollRun {
  id: number;
  run_number: string;
  pay_month: string;
  total_gross: number;
  total_deductions: number;
  total_net: number;
  status: 'draft' | 'verified' | 'approved' | 'posted' | 'partially_paid' | 'paid' | 'rejected';
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
  employee_code?: string | null;
  department_name?: string | null;
}

export interface CashBankAccount {
  id: number;
  account_name: string;
  account_type: 'cash' | 'bank';
  account_number: string | null;
  bank_name: string | null;
  coa_code: string;
  opening_balance: number;
  current_balance: number;
  active: number;
}

export interface CashBankTransfer {
  id: number;
  transfer_number: string;
  transfer_date: string;
  from_account_id: number;
  to_account_id: number;
  from_account_name: string;
  to_account_name: string;
  amount: number;
  reference_no: string | null;
  notes: string | null;
  journal_entry_number?: string | null;
  created_by_name?: string | null;
}

export interface FinancePayment {
  id: number;
  payment_number: string;
  payment_date: string;
  payment_category: string;
  payee_name: string;
  cash_bank_account_id: number;
  cash_bank_account_name: string;
  payment_method: string;
  amount: number;
  reference_no: string | null;
  attachment_ref: string | null;
  linked_type: string | null;
  linked_id: number | null;
  notes: string | null;
  journal_entry_number?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface FinanceReceipt {
  id: number;
  receipt_number: string;
  receipt_date: string;
  income_category: string;
  payer_name: string;
  cash_bank_account_id: number;
  cash_bank_account_name: string;
  payment_method: string;
  amount: number;
  reference_no: string | null;
  attachment_ref: string | null;
  notes: string | null;
  journal_entry_number?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface GrvRecord {
  id: number;
  grn_number: string;
  supplier_name: string;
  invoice_ref: string | null;
  delivery_date: string | null;
  received_date: string | null;
  department_name: string | null;
  attachment_ref: string | null;
  approval_status: 'pending' | 'approved' | 'rejected';
  rejected_reason?: string | null;
  total_cost: number;
  notes: string | null;
  received_by_name: string | null;
  approved_by_name: string | null;
  bill_number: string | null;
  bill_status: string | null;
  bill_paid_amount: number | null;
  items_summary?: string;
  received_at: string;
}

export interface BalanceSheetData {
  assets: Array<ChartAccount & { debit_total: number; credit_total: number; net_balance: number }>;
  liabilities: Array<ChartAccount & { debit_total: number; credit_total: number; net_balance: number }>;
  equity: Array<ChartAccount & { debit_total: number; credit_total: number; net_balance: number }>;
  currentNetIncome: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  balanced: boolean;
}

export interface ClinicSettings {
  clinicName: string;
  currencyCode: string;
  currencySymbol: string;
  timezone: string;
  expenseAutoPostLimit?: number;
  profile?: {
    legalName: string;
    facilityCode: string;
    address: string;
    phone: string;
    email: string;
    operatingHours: string;
    taxId: string;
  };
  clinical?: {
    mrnPrefix: string;
    visitPrefix: string;
    defaultSlotMinutes: number;
    maxDailyPatientsPerDoctor: number;
    allowWalkInRegistration: boolean;
    requireVitalsBeforeConsultation: boolean;
    requirePaymentBeforeConsultation: boolean;
    vitalReferenceRanges: {
      bpSystolicMin: number;
      bpSystolicMax: number;
      bpDiastolicMin: number;
      bpDiastolicMax: number;
      tempMinC: number;
      tempMaxC: number;
      pulseMin: number;
      pulseMax: number;
      spo2Min: number;
    };
    autoAssignRoomBySpecialty: boolean;
  };
  billing?: {
    defaultTaxRatePct: number;
    cashierMaxDiscountPct: number;
    requireShiftForCollection: boolean;
    allowPartialPayments: boolean;
    allowInsuranceCreditBilling: boolean;
    receiptFooterNote: string;
  };
  notifications?: {
    enableInAppAlerts: boolean;
    enableSmsAlerts: boolean;
    enableEmailAlerts: boolean;
    notifyDoctorOnAssignment: boolean;
    notifyNurseOnPaymentClearance: boolean;
    notifyAdminOnAccessReview: boolean;
    criticalLabAlertImmediate: boolean;
  };
  documents?: {
    prescriptionHeader: string;
    labReportHeader: string;
    radiologyHeader: string;
    invoiceHeader: string;
    showClinicStampOnPrint: boolean;
  };
  security?: {
    sessionTimeoutMinutes: number;
    passwordMinLength: number;
    requireMixedCasePassword: boolean;
    maxFailedLoginAttempts: number;
    lockoutDurationMinutes: number;
    enforce2faForPrivilegedRoles: boolean;
    allowMultipleActiveSessions: boolean;
  };
  lastBackupVerifiedAt?: string | null;
  lastBackupVerifiedBy?: string | null;
}

export interface StaffUserRow {
  id: number;
  employee_id?: number | null;
  employee_number?: string | null;
  hr_department_name?: string | null;
  hr_job_position?: string | null;
  hr_status?: string | null;
  access_review_required?: number;
  username?: string | null;
  full_name: string;
  email: string;
  specialty: string | null;
  active: number;
  status: 'active' | 'inactive' | 'locked' | string;
  exception_approved?: number;
  must_change_password?: number;
  two_fa_enabled?: number;
  failed_attempts?: number;
  locked_until?: string | null;
  last_login_at: string | null;
  created_at?: string;
  role_code: string;
  role_name: string;
  department_names?: string;
  department_ids?: number[];
  clinic_unit_ids?: number[];
  active_session_count?: number;
}

export interface HrEmployeeAdminOption {
  id: number;
  employee_number: string;
  user_id: number | null;
  full_name: string;
  gender: string;
  phone: string | null;
  email: string | null;
  department_name: string;
  job_position: string;
  employment_type: string;
  status: 'active' | 'inactive' | 'terminated' | string;
  terminated_at: string | null;
  termination_reason: string | null;
  access_review_required: number;
  access_reviewed_at: string | null;
  has_system_account: boolean;
  account_count: number;
  linked_user_id: number | null;
  linked_username: string | null;
  linked_email: string | null;
  linked_status: string | null;
  linked_roles: string;
}

export interface DepartmentConfig {
  id: number;
  code: string;
  name: string;
  category: string;
  head_name: string | null;
  description: string | null;
  active: number;
  assigned_staff_count?: number;
  active_room_count?: number;
}

export interface SpecialtyConfig {
  id: number;
  code: string;
  name: string;
  department_id: number | null;
  department_name?: string | null;
  description: string | null;
  consultation_fee: number;
  active: number;
}

export interface ClinicRoomConfig {
  id: number;
  room_code: string;
  name: string;
  department_id: number | null;
  department_name?: string | null;
  specialty_id: number | null;
  specialty_name?: string | null;
  room_type: string;
  capacity: number;
  active: number;
}

export interface DoctorProfileConfig {
  id: number;
  username: string | null;
  full_name: string;
  email: string;
  specialty: string | null;
  active: number;
  status: string;
  employee_number: string | null;
  hr_department_name: string | null;
  licence_number: string | null;
  licence_expiry: string | null;
  assigned_rooms: string;
  active_visits_count: number;
}

export interface UserSessionRow {
  jti: string;
  user_id: number;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: number | null;
}

export interface BackupStatusResponse {
  dialect: 'sqlite' | 'mysql';
  mysqlConfigured: boolean;
  sqliteFileBytes: number | null;
  sqliteIntegrity: string;
  lastBackupVerifiedAt: string | null;
  lastBackupVerifiedBy: string | null;
  tableCounts: {
    patients: number;
    visits: number;
    invoices: number;
    auditLogs: number;
    hrEmployees: number;
    users: number;
    activeSessions: number;
  };
}




