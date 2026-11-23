-- Clinic360 MySQL 8.0+ Relational Database Schema
-- Charset: utf8mb4, Engine: InnoDB, Money: DECIMAL(12,2)

CREATE TABLE IF NOT EXISTS branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  address VARCHAR(255),
  phone VARCHAR(40),
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(10) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  system_role TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  module VARCHAR(60) NOT NULL,
  description VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT NOT NULL,
  permission_id INT NOT NULL,
  scope ENUM('own','department','branch','all') NOT NULL DEFAULT 'all',
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (permission_id) REFERENCES permissions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  department_id INT NULL,
  full_name VARCHAR(140) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  specialty VARCHAR(120) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  two_fa_enabled TINYINT(1) NOT NULL DEFAULT 0,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INT NOT NULL,
  role_id INT NOT NULL,
  branch_id INT NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, role_id, branch_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sequences (
  seq_key VARCHAR(40) PRIMARY KEY,
  prefix VARCHAR(20) NOT NULL,
  current_value INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS patients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  mrn VARCHAR(32) NOT NULL UNIQUE,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  sex ENUM('Male','Female','Other') NOT NULL,
  date_of_birth DATE NOT NULL,
  phone VARCHAR(40) NOT NULL,
  email VARCHAR(160) NULL,
  address VARCHAR(255) NULL,
  next_of_kin_name VARCHAR(140) NULL,
  next_of_kin_phone VARCHAR(40) NULL,
  blood_group VARCHAR(8) NULL,
  allergies TEXT NULL,
  patient_type ENUM('self-pay','insurance','credit','exempt') NOT NULL DEFAULT 'self-pay',
  payer_name VARCHAR(140) NULL,
  insurance_number VARCHAR(80) NULL,
  national_id VARCHAR(80) NULL,
  status ENUM('active','merged','inactive') NOT NULL DEFAULT 'active',
  merged_into_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by INT NULL,
  INDEX idx_patients_name (last_name, first_name),
  INDEX idx_patients_phone (phone),
  INDEX idx_patients_mrn (mrn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS queue_tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  ticket_number VARCHAR(24) NOT NULL,
  department ENUM('OPD','LAB','IMG','PHA','CSH') NOT NULL DEFAULT 'OPD',
  patient_id INT NOT NULL,
  visit_id INT NULL,
  priority ENUM('emergency','urgent','routine') NOT NULL DEFAULT 'routine',
  status ENUM('waiting','called','in_service','completed','skipped') NOT NULL DEFAULT 'waiting',
  notes VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  called_at DATETIME NULL,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS appointments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  patient_id INT NOT NULL,
  doctor_id INT NOT NULL,
  department_id INT NULL,
  appointment_date DATE NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  visit_type ENUM('consultation','follow-up','procedure','checkup') NOT NULL DEFAULT 'consultation',
  reason VARCHAR(255) NULL,
  status ENUM('scheduled','checked_in','completed','cancelled','no_show') NOT NULL DEFAULT 'scheduled',
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_appt_doc_date (doctor_id, appointment_date),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (doctor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS visits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  visit_number VARCHAR(32) NOT NULL UNIQUE,
  patient_id INT NOT NULL,
  doctor_id INT NULL,
  appointment_id INT NULL,
  visit_type ENUM('walk_in','scheduled') NOT NULL DEFAULT 'walk_in',
  specialty VARCHAR(80) NULL,
  consultation_invoice_id INT NULL,
  workflow_stage ENUM('awaiting_payment','paid_awaiting_vitals','ready_for_doctor','in_consultation','awaiting_diagnostics','results_ready','awaiting_pharmacy','completed') NOT NULL DEFAULT 'paid_awaiting_vitals',
  triage_priority ENUM('emergency','urgent','routine') NOT NULL DEFAULT 'routine',
  chief_complaint TEXT NULL,
  history_notes TEXT NULL,
  exam_notes TEXT NULL,
  diagnosis_code VARCHAR(20) NULL,
  diagnosis_text TEXT NULL,
  treatment_plan TEXT NULL,
  follow_up_date DATE NULL,
  status ENUM('triage','in_consultation','awaiting_results','closed') NOT NULL DEFAULT 'triage',
  closed_at DATETIME NULL,
  closed_by INT NULL,
  reopen_reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vitals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visit_id INT NOT NULL,
  patient_id INT NOT NULL,
  bp_systolic INT NULL,
  bp_diastolic INT NULL,
  temperature DECIMAL(4,1) NULL,
  pulse INT NULL,
  respiratory_rate INT NULL,
  spo2 INT NULL,
  weight_kg DECIMAL(5,2) NULL,
  height_cm DECIMAL(5,1) NULL,
  bmi DECIMAL(4,1) NULL,
  blood_glucose DECIMAL(5,1) NULL,
  early_warning_flag TINYINT(1) NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by INT NOT NULL,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS services (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  category ENUM('consultation','registration','lab','imaging','procedure','pharmacy','bed') NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lab_tests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  sample_type VARCHAR(60) NOT NULL,
  unit VARCHAR(40) NULL,
  reference_range VARCHAR(120) NULL,
  price DECIMAL(12,2) NOT NULL,
  turnaround_mins INT NOT NULL DEFAULT 60,
  analyte_template_json TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS imaging_catalog (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  modality ENUM('X-Ray','Ultrasound','ECG','CT','Echo') NOT NULL,
  body_region VARCHAR(80) NOT NULL,
  price DECIMAL(12,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS medicines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  generic_name VARCHAR(160) NOT NULL,
  strength VARCHAR(60) NOT NULL,
  form VARCHAR(40) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  stock_qty INT NOT NULL DEFAULT 0,
  reorder_level INT NOT NULL DEFAULT 20,
  batch_number VARCHAR(60) NOT NULL,
  expiry_date DATE NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cashier_shifts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  cashier_id INT NOT NULL,
  opening_float DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  expected_cash DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  counted_cash DECIMAL(12,2) NULL,
  variance DECIMAL(12,2) NULL,
  status ENUM('open','closed','reconciled') NOT NULL DEFAULT 'open',
  opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  reconciled_by INT NULL,
  notes VARCHAR(255) NULL,
  FOREIGN KEY (cashier_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  invoice_number VARCHAR(32) NOT NULL UNIQUE,
  patient_id INT NOT NULL,
  visit_id INT NULL,
  payer_type ENUM('self-pay','insurance','credit','exempt') NOT NULL DEFAULT 'self-pay',
  payer_name VARCHAR(140) NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('unpaid','partial','paid','credit_billed','voided') NOT NULL DEFAULT 'unpaid',
  notes VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS invoice_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  service_code VARCHAR(32) NULL,
  description VARCHAR(200) NOT NULL,
  category VARCHAR(40) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(12,2) NOT NULL,
  line_total DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id INT NOT NULL DEFAULT 1,
  invoice_id INT NOT NULL,
  patient_id INT NOT NULL,
  shift_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('cash','card','mobile_money','bank_transfer') NOT NULL DEFAULT 'cash',
  reference_number VARCHAR(80) NULL,
  status ENUM('completed','refunded') NOT NULL DEFAULT 'completed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS receipts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  receipt_number VARCHAR(32) NOT NULL UNIQUE,
  payment_id INT NOT NULL,
  invoice_id INT NOT NULL,
  patient_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method VARCHAR(40) NOT NULL,
  reprint_count INT NOT NULL DEFAULT 0,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_by INT NOT NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS approval_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_type ENUM('discount','void_invoice','refund','reopen_visit') NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INT NOT NULL,
  requested_amount DECIMAL(12,2) NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  requested_by INT NOT NULL,
  decided_by INT NULL,
  decision_note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME NULL,
  FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lab_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visit_id INT NOT NULL,
  patient_id INT NOT NULL,
  test_id INT NOT NULL,
  invoice_id INT NULL,
  ordered_by INT NOT NULL,
  sample_barcode VARCHAR(40) NULL,
  result_value VARCHAR(160) NULL,
  previous_result_value VARCHAR(160) NULL,
  abnormal_flag ENUM('normal','high','low','critical') NULL,
  result_notes VARCHAR(255) NULL,
  panel_results_json TEXT NULL,
  rejection_reason VARCHAR(255) NULL,
  amend_reason VARCHAR(255) NULL,
  status ENUM('ordered','collected','resulted','verified','rejected','amended') NOT NULL DEFAULT 'ordered',
  entered_by INT NULL,
  verified_by INT NULL,
  critical_ack_by INT NULL,
  critical_ack_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at DATETIME NULL,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (test_id) REFERENCES lab_tests(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS imaging_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visit_id INT NOT NULL,
  patient_id INT NOT NULL,
  catalog_id INT NOT NULL,
  invoice_id INT NULL,
  ordered_by INT NOT NULL,
  clinical_question VARCHAR(255) NULL,
  pregnancy_checked TINYINT(1) NOT NULL DEFAULT 0,
  exam_notes VARCHAR(255) NULL,
  findings TEXT NULL,
  impression TEXT NULL,
  addendum TEXT NULL,
  status ENUM('ordered','scheduled','performed','reported_draft','reported_final') NOT NULL DEFAULT 'ordered',
  performed_by INT NULL,
  reported_by INT NULL,
  finalised_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (catalog_id) REFERENCES imaging_catalog(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prescriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visit_id INT NOT NULL,
  patient_id INT NOT NULL,
  doctor_id INT NOT NULL,
  invoice_id INT NULL,
  status ENUM('awaiting_stock_check','pending_payment','paid_ready_to_dispense','pending','partial','dispensed','cancelled') NOT NULL DEFAULT 'awaiting_stock_check',
  notes VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispensed_at DATETIME NULL,
  dispensed_by INT NULL,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prescription_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prescription_id INT NOT NULL,
  medicine_id INT NOT NULL,
  dosage VARCHAR(80) NOT NULL,
  frequency VARCHAR(80) NOT NULL,
  duration_days INT NOT NULL DEFAULT 5,
  quantity INT NOT NULL,
  selected_qty INT NULL,
  dispensed_qty INT NOT NULL DEFAULT 0,
  external_qty INT NOT NULL DEFAULT 0,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  instructions VARCHAR(255) NULL,
  FOREIGN KEY (prescription_id) REFERENCES prescriptions(id),
  FOREIGN KEY (medicine_id) REFERENCES medicines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  department VARCHAR(60) NOT NULL,
  daily_tariff DECIMAL(12,2) NOT NULL DEFAULT 80.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS beds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ward_id INT NOT NULL,
  bed_number VARCHAR(20) NOT NULL,
  status ENUM('vacant','reserved','occupied','cleaning','out_of_service') NOT NULL DEFAULT 'vacant',
  FOREIGN KEY (ward_id) REFERENCES wards(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admission_number VARCHAR(32) NOT NULL UNIQUE,
  patient_id INT NOT NULL,
  visit_id INT NULL,
  admitting_doctor_id INT NOT NULL,
  ward_id INT NOT NULL,
  bed_id INT NULL,
  admission_diagnosis VARCHAR(255) NOT NULL,
  deposit_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  bed_days_billed INT NOT NULL DEFAULT 0,
  last_bed_billed_at DATETIME NULL,
  discharge_summary TEXT NULL,
  discharge_cleared TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('ordered','admitted','discharge_ordered','cleared','discharged') NOT NULL DEFAULT 'ordered',
  admitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  discharged_at DATETIME NULL,
  INDEX idx_admissions_patient_status (patient_id, status),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (ward_id) REFERENCES wards(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS medication_administrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admission_id INT NOT NULL,
  patient_id INT NOT NULL,
  medicine_name VARCHAR(160) NOT NULL,
  dose VARCHAR(80) NOT NULL,
  scheduled_time VARCHAR(20) NOT NULL,
  status ENUM('due','given','withheld') NOT NULL DEFAULT 'due',
  reason_not_given VARCHAR(255) NULL,
  administered_by_name VARCHAR(140) NULL,
  administered_at DATETIME NULL,
  FOREIGN KEY (admission_id) REFERENCES admissions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS store_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  category ENUM('medicine','consumable','reagent') NOT NULL DEFAULT 'medicine',
  unit VARCHAR(40) NOT NULL DEFAULT 'unit',
  medicine_id INT NULL,
  reorder_level INT NOT NULL DEFAULT 25,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  selling_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (medicine_id) REFERENCES medicines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  location ENUM('main_store','dispensary','lab','ward') NOT NULL DEFAULT 'main_store',
  batch_number VARCHAR(60) NOT NULL,
  expiry_date DATE NOT NULL,
  qty_on_hand INT NOT NULL DEFAULT 0,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('active','blocked_expired','depleted') NOT NULL DEFAULT 'active',
  block_reason VARCHAR(255) NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_batches_fefo (item_id, location, status, expiry_date),
  FOREIGN KEY (item_id) REFERENCES store_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS goods_receipts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  grn_number VARCHAR(32) NOT NULL UNIQUE,
  supplier_name VARCHAR(160) NOT NULL,
  invoice_ref VARCHAR(80) NULL,
  total_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(255) NULL,
  received_by INT NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS grn_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  grn_id INT NOT NULL,
  item_id INT NOT NULL,
  batch_number VARCHAR(60) NOT NULL,
  expiry_date DATE NOT NULL,
  quantity INT NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (grn_id) REFERENCES goods_receipts(id),
  FOREIGN KEY (item_id) REFERENCES store_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_requisitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  req_number VARCHAR(32) NOT NULL UNIQUE,
  from_location ENUM('main_store') NOT NULL DEFAULT 'main_store',
  to_location ENUM('dispensary','lab','ward') NOT NULL DEFAULT 'dispensary',
  status ENUM('pending','issued','rejected') NOT NULL DEFAULT 'pending',
  notes VARCHAR(255) NULL,
  requested_by INT NOT NULL,
  issued_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_requisition_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  requisition_id INT NOT NULL,
  item_id INT NOT NULL,
  requested_qty INT NOT NULL,
  issued_qty INT NOT NULL DEFAULT 0,
  FOREIGN KEY (requisition_id) REFERENCES stock_requisitions(id),
  FOREIGN KEY (item_id) REFERENCES store_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS patient_deposits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  deposit_number VARCHAR(32) NOT NULL UNIQUE,
  patient_id INT NOT NULL,
  admission_id INT NULL,
  shift_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  remaining_amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('cash','card','mobile_money','bank_transfer') NOT NULL DEFAULT 'cash',
  reference_number VARCHAR(80) NULL,
  status ENUM('active','applied','refunded') NOT NULL DEFAULT 'active',
  collected_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_deposits_patient (patient_id, status),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  target_role VARCHAR(10) NOT NULL,
  title VARCHAR(140) NOT NULL,
  message VARCHAR(255) NOT NULL,
  severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  entity_type VARCHAR(40) NULL,
  entity_id INT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_role_read (target_role, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT NULL,
  user_name VARCHAR(140) NOT NULL,
  role_at_time VARCHAR(80) NOT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(60) NULL,
  patient_id INT NULL,
  before_json TEXT NULL,
  after_json TEXT NULL,
  reason VARCHAR(255) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  branch_id INT NOT NULL DEFAULT 1,
  prev_hash VARCHAR(64) NOT NULL,
  row_hash VARCHAR(64) NOT NULL,
  INDEX idx_audit_action (action),
  INDEX idx_audit_patient (patient_id),
  INDEX idx_audit_occurred (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_visits_patient_status ON visits(patient_id, status);
CREATE INDEX idx_invoices_patient_status ON invoices(patient_id, status);
CREATE INDEX idx_lab_orders_visit_status ON lab_orders(visit_id, status);
CREATE INDEX idx_imaging_orders_visit_status ON imaging_orders(visit_id, status);
CREATE INDEX idx_prescriptions_visit_status ON prescriptions(visit_id, status);
CREATE INDEX idx_payments_invoice_shift ON payments(invoice_id, shift_id);

-- Priority 2: Scheduling Blocks, Nursing Procedures, Imaging Attachments
CREATE TABLE IF NOT EXISTS doctor_blocks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id INT NOT NULL,
  block_date DATE NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  block_type ENUM('leave','off_duty','surgery','unavailable') NOT NULL DEFAULT 'unavailable',
  reason VARCHAR(255) NULL,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_doc_blocks_date (doctor_id, block_date),
  FOREIGN KEY (doctor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS nursing_procedures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visit_id INT NOT NULL,
  patient_id INT NOT NULL,
  service_id INT NOT NULL,
  service_code VARCHAR(32) NOT NULL,
  service_name VARCHAR(160) NOT NULL,
  invoice_id INT NULL,
  ordered_by INT NOT NULL,
  performed_by INT NULL,
  notes VARCHAR(255) NULL,
  status ENUM('ordered','completed') NOT NULL DEFAULT 'ordered',
  performed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS imaging_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  imaging_order_id INT NOT NULL,
  file_name VARCHAR(160) NOT NULL,
  mime_type VARCHAR(80) NOT NULL,
  data_url MEDIUMTEXT NOT NULL,
  caption VARCHAR(255) NULL,
  uploaded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (imaging_order_id) REFERENCES imaging_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Priority 2: Accounting Double-Entry Ledger, AR Claims, Supplier AP & Expense Vouchers
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(140) NOT NULL,
  account_type ENUM('asset','liability','equity','revenue','expense') NOT NULL,
  normal_balance ENUM('debit','credit') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS journal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_number VARCHAR(32) NOT NULL UNIQUE,
  entry_date DATE NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  source_id INT NULL,
  description VARCHAR(255) NOT NULL,
  total_debit DECIMAL(12,2) NOT NULL,
  total_credit DECIMAL(12,2) NOT NULL,
  posted_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_je_date_source (entry_date, source_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS journal_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL,
  account_id INT NOT NULL,
  debit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  credit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  memo VARCHAR(255) NULL,
  FOREIGN KEY (entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplier_bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_number VARCHAR(32) NOT NULL UNIQUE,
  grn_id INT NULL,
  supplier_name VARCHAR(160) NOT NULL,
  invoice_ref VARCHAR(80) NULL,
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('open','partial','paid') NOT NULL DEFAULT 'open',
  notes VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expense_vouchers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_number VARCHAR(32) NOT NULL UNIQUE,
  expense_date DATE NOT NULL,
  category VARCHAR(80) NOT NULL,
  account_id INT NOT NULL,
  payee_name VARCHAR(160) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('cash','bank_transfer','card','mobile_money') NOT NULL DEFAULT 'bank_transfer',
  description VARCHAR(255) NOT NULL,
  status ENUM('pending','approved','paid','rejected') NOT NULL DEFAULT 'pending',
  requested_by INT NOT NULL,
  approved_by INT NULL,
  paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS insurance_claims (
  id INT AUTO_INCREMENT PRIMARY KEY,
  claim_number VARCHAR(32) NOT NULL UNIQUE,
  payer_name VARCHAR(140) NOT NULL,
  invoice_id INT NOT NULL,
  patient_id INT NOT NULL,
  billed_amount DECIMAL(12,2) NOT NULL,
  settled_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('submitted','approved','partial','settled','paid','disputed') NOT NULL DEFAULT 'submitted',
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at DATETIME NULL,
  notes VARCHAR(255) NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Priority 3: HR & Payroll
CREATE TABLE IF NOT EXISTS staff_contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  employee_code VARCHAR(32) NOT NULL UNIQUE,
  department_name VARCHAR(100) NOT NULL,
  contract_type ENUM('full_time','part_time','locum') NOT NULL DEFAULT 'full_time',
  base_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  housing_allowance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  licence_number VARCHAR(80) NULL,
  licence_expiry DATE NULL,
  contract_start DATE NOT NULL,
  contract_end DATE NULL,
  status ENUM('active','expired','terminated') NOT NULL DEFAULT 'active',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leave_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  leave_type ENUM('annual','sick','study','emergency') NOT NULL DEFAULT 'annual',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days_count INT NOT NULL DEFAULT 1,
  reason VARCHAR(255) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  decided_by INT NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_number VARCHAR(32) NOT NULL UNIQUE,
  pay_month VARCHAR(10) NOT NULL,
  total_gross DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_deductions DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_net DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('draft','posted') NOT NULL DEFAULT 'draft',
  journal_entry_id INT NULL,
  created_by INT NOT NULL,
  posted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payroll_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id INT NOT NULL,
  user_id INT NOT NULL,
  staff_name VARCHAR(140) NOT NULL,
  role_code VARCHAR(16) NOT NULL,
  base_salary DECIMAL(12,2) NOT NULL,
  allowances DECIMAL(12,2) NOT NULL,
  tax_deduction DECIMAL(12,2) NOT NULL,
  net_pay DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_invoices_patient ON invoices(patient_id, status);
CREATE INDEX idx_visits_patient ON visits(patient_id, workflow_stage);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_queue_dept_status ON queue_tickets(department, status);

