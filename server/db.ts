import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';

export type DbDialect = 'mysql' | 'sqlite';

let mysqlPool: mysql.Pool | null = null;
let sqliteDb: Database.Database | null = null;
let activeDialect: DbDialect = 'sqlite';

export function getDialect(): DbDialect {
  return activeDialect;
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (activeDialect === 'mysql' && mysqlPool) {
    const [rows] = await mysqlPool.query(sql, params as never);
    return rows as T[];
  }
  if (!sqliteDb) throw new Error('Database not initialized');
  const stmt = sqliteDb.prepare(sql);
  return stmt.all(...params) as T[];
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
  if (activeDialect === 'mysql' && mysqlPool) {
    const [result] = await mysqlPool.query(sql, params as never) as unknown as [{ insertId: number; affectedRows: number }, unknown];
    return { insertId: Number(result.insertId || 0), affectedRows: Number(result.affectedRows || 0) };
  }
  if (!sqliteDb) throw new Error('Database not initialized');
  const stmt = sqliteDb.prepare(sql);
  const info = stmt.run(...params);
  return { insertId: Number(info.lastInsertRowid || 0), affectedRows: Number(info.changes || 0) };
}

export async function nextSequence(seqKey: string): Promise<string> {
  const row = await queryOne<{ prefix: string; current_value: number }>(
    'SELECT prefix, current_value FROM sequences WHERE seq_key = ?',
    [seqKey]
  );
  if (!row) {
    throw new Error(`Missing sequence key: ${seqKey}`);
  }
  const nextVal = row.current_value + 1;
  await execute('UPDATE sequences SET current_value = ? WHERE seq_key = ?', [nextVal, seqKey]);
  return `${row.prefix}${String(nextVal).padStart(6, '0')}`;
}

function safeAddColumn(db: Database.Database, table: string, columnDef: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch {
    // Column already exists
  }
}

async function initSqliteSchema(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      system_role INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      module TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all',
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id),
      FOREIGN KEY (permission_id) REFERENCES permissions(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      department_id INTEGER NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      specialty TEXT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT NULL,
      last_login_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, role_id, branch_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS sequences (
      seq_key TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      current_value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      mrn TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      sex TEXT NOT NULL,
      date_of_birth TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NULL,
      address TEXT NULL,
      next_of_kin_name TEXT NULL,
      next_of_kin_phone TEXT NULL,
      blood_group TEXT NULL,
      allergies TEXT NULL,
      patient_type TEXT NOT NULL DEFAULT 'self-pay',
      payer_name TEXT NULL,
      insurance_number TEXT NULL,
      national_id TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      merged_into_id INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER NULL
    );

    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);
    CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);

    CREATE TABLE IF NOT EXISTS queue_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      ticket_number TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'OPD',
      patient_id INTEGER NOT NULL,
      visit_id INTEGER NULL,
      priority TEXT NOT NULL DEFAULT 'routine',
      status TEXT NOT NULL DEFAULT 'waiting',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      called_at TEXT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      department_id INTEGER NULL,
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      visit_type TEXT NOT NULL DEFAULT 'consultation',
      reason TEXT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      visit_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NULL,
      appointment_id INTEGER NULL,
      triage_priority TEXT NOT NULL DEFAULT 'routine',
      chief_complaint TEXT NULL,
      history_notes TEXT NULL,
      exam_notes TEXT NULL,
      diagnosis_code TEXT NULL,
      diagnosis_text TEXT NULL,
      treatment_plan TEXT NULL,
      follow_up_date TEXT NULL,
      status TEXT NOT NULL DEFAULT 'triage',
      closed_at TEXT NULL,
      closed_by INTEGER NULL,
      reopen_reason TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      bp_systolic INTEGER NULL,
      bp_diastolic INTEGER NULL,
      temperature REAL NULL,
      pulse INTEGER NULL,
      respiratory_rate INTEGER NULL,
      spo2 INTEGER NULL,
      weight_kg REAL NULL,
      height_cm REAL NULL,
      bmi REAL NULL,
      blood_glucose REAL NULL,
      early_warning_flag INTEGER NOT NULL DEFAULT 0,
      notes TEXT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      recorded_by INTEGER NOT NULL,
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS lab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sample_type TEXT NOT NULL,
      unit TEXT NULL,
      reference_range TEXT NULL,
      price REAL NOT NULL,
      turnaround_mins INTEGER NOT NULL DEFAULT 60
    );

    CREATE TABLE IF NOT EXISTS imaging_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      modality TEXT NOT NULL,
      body_region TEXT NOT NULL,
      price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      generic_name TEXT NOT NULL,
      strength TEXT NOT NULL,
      form TEXT NOT NULL,
      unit_price REAL NOT NULL,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      reorder_level INTEGER NOT NULL DEFAULT 20,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cashier_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      cashier_id INTEGER NOT NULL,
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL NOT NULL DEFAULT 0,
      counted_cash REAL NULL,
      variance REAL NULL,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT NULL,
      reconciled_by INTEGER NULL,
      notes TEXT NULL,
      FOREIGN KEY (cashier_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      invoice_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      visit_id INTEGER NULL,
      payer_type TEXT NOT NULL DEFAULT 'self-pay',
      payer_name TEXT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      service_code TEXT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      invoice_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      shift_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      reference_number TEXT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      payment_id INTEGER NOT NULL,
      invoice_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      reprint_count INTEGER NOT NULL DEFAULT 0,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      issued_by INTEGER NOT NULL,
      FOREIGN KEY (payment_id) REFERENCES payments(id),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      requested_amount REAL NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      decided_by INTEGER NULL,
      decision_note TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT NULL,
      FOREIGN KEY (requested_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS lab_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      test_id INTEGER NOT NULL,
      invoice_id INTEGER NULL,
      ordered_by INTEGER NOT NULL,
      sample_barcode TEXT NULL,
      result_value TEXT NULL,
      previous_result_value TEXT NULL,
      abnormal_flag TEXT NULL,
      result_notes TEXT NULL,
      rejection_reason TEXT NULL,
      amend_reason TEXT NULL,
      status TEXT NOT NULL DEFAULT 'ordered',
      entered_by INTEGER NULL,
      verified_by INTEGER NULL,
      critical_ack_by INTEGER NULL,
      critical_ack_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT NULL,
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (test_id) REFERENCES lab_tests(id)
    );

    CREATE TABLE IF NOT EXISTS imaging_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      catalog_id INTEGER NOT NULL,
      invoice_id INTEGER NULL,
      ordered_by INTEGER NOT NULL,
      clinical_question TEXT NULL,
      pregnancy_checked INTEGER NOT NULL DEFAULT 0,
      exam_notes TEXT NULL,
      findings TEXT NULL,
      impression TEXT NULL,
      addendum TEXT NULL,
      status TEXT NOT NULL DEFAULT 'ordered',
      performed_by INTEGER NULL,
      reported_by INTEGER NULL,
      finalised_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (catalog_id) REFERENCES imaging_catalog(id)
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      invoice_id INTEGER NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      dispensed_at TEXT NULL,
      dispensed_by INTEGER NULL,
      FOREIGN KEY (visit_id) REFERENCES visits(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS prescription_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL,
      medicine_id INTEGER NOT NULL,
      dosage TEXT NOT NULL,
      frequency TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 5,
      quantity INTEGER NOT NULL,
      dispensed_qty INTEGER NOT NULL DEFAULT 0,
      instructions TEXT NULL,
      FOREIGN KEY (prescription_id) REFERENCES prescriptions(id),
      FOREIGN KEY (medicine_id) REFERENCES medicines(id)
    );

    CREATE TABLE IF NOT EXISTS wards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      daily_tariff REAL NOT NULL DEFAULT 80.0
    );

    CREATE TABLE IF NOT EXISTS beds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ward_id INTEGER NOT NULL,
      bed_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'vacant',
      FOREIGN KEY (ward_id) REFERENCES wards(id)
    );

    CREATE TABLE IF NOT EXISTS admissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      visit_id INTEGER NULL,
      admitting_doctor_id INTEGER NOT NULL,
      ward_id INTEGER NOT NULL,
      bed_id INTEGER NULL,
      admission_diagnosis TEXT NOT NULL,
      deposit_paid REAL NOT NULL DEFAULT 0,
      discharge_summary TEXT NULL,
      discharge_cleared INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ordered',
      admitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      discharged_at TEXT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (ward_id) REFERENCES wards(id)
    );

    CREATE TABLE IF NOT EXISTS medication_administrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      medicine_name TEXT NOT NULL,
      dose TEXT NOT NULL,
      scheduled_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'due',
      reason_not_given TEXT NULL,
      administered_by_name TEXT NULL,
      administered_at TEXT NULL,
      FOREIGN KEY (admission_id) REFERENCES admissions(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_role TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      entity_type TEXT NULL,
      entity_id INTEGER NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER NULL,
      user_name TEXT NOT NULL,
      role_at_time TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NULL,
      patient_id INTEGER NULL,
      before_json TEXT NULL,
      after_json TEXT NULL,
      reason TEXT NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      branch_id INTEGER NOT NULL DEFAULT 1,
      prev_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL
    );
  `);

  // Safe migrations for pre-existing clinic360.db files
  safeAddColumn(db, 'cashier_shifts', 'reconciled_by INTEGER NULL');
  safeAddColumn(db, 'receipts', 'reprint_count INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'lab_orders', 'previous_result_value TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'rejection_reason TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'amend_reason TEXT NULL');
  safeAddColumn(db, 'lab_orders', 'critical_ack_by INTEGER NULL');
  safeAddColumn(db, 'lab_orders', 'critical_ack_at TEXT NULL');
}

async function ensureExtraPermissionsAndSeeds() {
  const extraPerms: Array<[string, string, string]> = [
    ['order.imaging.create', 'OPD', 'Order diagnostic imaging exams'],
    ['imaging.order.read', 'Imaging', 'View imaging worklist and reports'],
    ['imaging.exam.perform', 'Imaging', 'Perform imaging scan and record exam details'],
    ['imaging.report.finalise', 'Imaging', 'Write and finalise radiology report'],
    ['ipd.admission.read', 'Inpatient', 'View wards, bed board, and admissions'],
    ['ipd.admission.create', 'Inpatient', 'Admit patient to inpatient ward'],
    ['ipd.bed.assign', 'Inpatient', 'Assign, transfer, and clear ward beds'],
    ['ipd.mar.give', 'Inpatient', 'Administer scheduled inpatient medications (MAR)'],
    ['ipd.discharge.create', 'Inpatient', 'Write discharge summary and order discharge'],
    ['ipd.discharge.clear', 'Inpatient', 'Clear final inpatient bill for discharge'],
    ['billing.shift.reconcile', 'Finance', 'Reconcile closed cashier shifts'],
    ['audit.trace', 'Audit', 'Run end-to-end patient and user audit traces'],
  ];

  for (const [code, module, description] of extraPerms) {
    const existing = await queryOne<{ id: number }>('SELECT id FROM permissions WHERE code = ?', [code]);
    if (!existing) {
      await execute('INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)', [code, module, description]);
    }
  }

  const extraRoleBindings: Record<string, string[]> = {
    DOC: ['order.imaging.create', 'imaging.order.read', 'ipd.admission.read', 'ipd.admission.create', 'ipd.discharge.create'],
    WRD: ['ipd.admission.read', 'ipd.bed.assign', 'ipd.mar.give', 'imaging.order.read'],
    IMG: ['imaging.order.read', 'imaging.exam.perform', 'imaging.report.finalise'],
    REC: ['ipd.admission.read'],
    CSH: ['ipd.admission.read', 'ipd.discharge.clear'],
    NUR: ['imaging.order.read'],
    ACC: ['billing.shift.reconcile', 'ipd.admission.read'],
    MGR: ['imaging.order.read', 'ipd.admission.read', 'audit.trace'],
    AUD: ['imaging.order.read', 'ipd.admission.read', 'audit.trace'],
  };

  for (const [roleCode, permCodes] of Object.entries(extraRoleBindings)) {
    const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = ?', [roleCode]);
    if (!role) continue;
    for (const pCode of permCodes) {
      const perm = await queryOne<{ id: number }>('SELECT id FROM permissions WHERE code = ?', [pCode]);
      if (!perm) continue;
      const exists = await queryOne('SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?', [
        role.id,
        perm.id,
      ]);
      if (!exists) {
        await execute('INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?)', [
          role.id,
          perm.id,
          'all',
        ]);
      }
    }
  }

  // Ensure ADM sequence for IPD exists
  const admSeq = await queryOne('SELECT seq_key FROM sequences WHERE seq_key = ?', ['ADM']);
  if (!admSeq) {
    await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['ADM', 'ADM-26-', 10]);
  }

  // Ensure WRD and IMG demo accounts exist
  const demoPasswordHash = await bcrypt.hash('Clinic360!', 10);
  const newUsers = [
    { name: 'Grace Okonkwo, RN', email: 'wrd@clinic360.local', role: 'WRD', specialty: 'Medical & Surgical Wards' },
    { name: 'Dr. Kenji Sato', email: 'img@clinic360.local', role: 'IMG', specialty: 'Diagnostic Radiology' },
    { name: 'Dr. Leyla Farah (Lead Lab)', email: 'lab2@clinic360.local', role: 'LAB', specialty: 'Senior Lab Verifier' },
  ];
  for (const nu of newUsers) {
    const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ?', [nu.email]);
    if (!existing) {
      const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = ?', [nu.role]);
      const res = await execute(
        'INSERT INTO users (branch_id, full_name, email, password_hash, specialty) VALUES (1, ?, ?, ?, ?)',
        [nu.name, nu.email, demoPasswordHash, nu.specialty]
      );
      if (role) {
        await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [res.insertId, role.id]);
      }
    }
  }

  // Seed Imaging Catalog
  const imgCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM imaging_catalog');
  if (Number(imgCount?.cnt || 0) === 0) {
    const exams = [
      ['IMG-CXR', 'Chest X-Ray (PA & Lateral)', 'X-Ray', 'Thorax', 65.0],
      ['IMG-US-ABD', 'Abdominal & Pelvic Ultrasound', 'Ultrasound', 'Abdomen', 90.0],
      ['IMG-ECG', '12-Lead Resting ECG', 'ECG', 'Cardiac', 35.0],
      ['IMG-ECHO', 'Transthoracic Echocardiogram', 'Echo', 'Cardiac', 140.0],
      ['IMG-KUB', 'Kidney-Ureter-Bladder X-Ray', 'X-Ray', 'Abdomen', 60.0],
    ];
    for (const [code, name, modality, region, price] of exams) {
      await execute(
        'INSERT INTO imaging_catalog (code, name, modality, body_region, price) VALUES (?, ?, ?, ?, ?)',
        [code, name, modality, region, price]
      );
    }
  }

  // Seed Wards & Beds
  const wardCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM wards');
  if (Number(wardCount?.cnt || 0) === 0) {
    const wGen = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      'WARD-GEN', 'General Medical Ward', 'Inpatient Medicine', 85.0,
    ]);
    const wMat = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      'WARD-SUR', 'Surgical & Recovery Ward', 'Surgery', 110.0,
    ]);
    const wIcu = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      'WARD-ICU', 'High Dependency / ICU', 'Critical Care', 240.0,
    ]);

    const bedDefs: Array<[number, string, string]> = [
      [wGen.insertId, 'GEN-101', 'occupied'],
      [wGen.insertId, 'GEN-102', 'vacant'],
      [wGen.insertId, 'GEN-103', 'vacant'],
      [wGen.insertId, 'GEN-104', 'cleaning'],
      [wMat.insertId, 'SUR-201', 'vacant'],
      [wMat.insertId, 'SUR-202', 'reserved'],
      [wIcu.insertId, 'ICU-01', 'vacant'],
      [wIcu.insertId, 'ICU-02', 'vacant'],
    ];
    for (const [wId, bNum, status] of bedDefs) {
      await execute('INSERT INTO beds (ward_id, bed_number, status) VALUES (?, ?, ?)', [wId, bNum, status]);
    }

    // Seed 1 active admission + MAR schedule for Evelyn Chen
    const evelyn = await queryOne<{ id: number }>("SELECT id FROM patients WHERE mrn = 'C360-000100'");
    const doc = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'doc@clinic360.local'");
    const bed101 = await queryOne<{ id: number }>("SELECT id FROM beds WHERE bed_number = 'GEN-101'");
    if (evelyn && doc && bed101) {
      const admRes = await execute(
        `INSERT INTO admissions (admission_number, patient_id, admitting_doctor_id, ward_id, bed_id, admission_diagnosis, deposit_paid, status)
         VALUES ('ADM-26-000010', ?, ?, ?, ?, 'Hypertensive urgency & community-acquired pneumonia monitoring', 250.00, 'admitted')`,
        [evelyn.id, doc.id, wGen.insertId, bed101.id]
      );
      await execute(
        `INSERT INTO medication_administrations (admission_id, patient_id, medicine_name, dose, scheduled_time, status, administered_by_name, administered_at)
         VALUES (?, ?, 'Azithromycin 500mg IV', '500mg once daily', '08:00', 'given', 'Grace Okonkwo, RN', datetime('now'))`,
        [admRes.insertId, evelyn.id]
      );
      await execute(
        `INSERT INTO medication_administrations (admission_id, patient_id, medicine_name, dose, scheduled_time, status)
         VALUES (?, ?, 'Lisinopril 10mg Oral', '10mg every 12h', '20:00', 'due')`,
        [admRes.insertId, evelyn.id]
      );
    }
  }

  // Seed initial imaging order & notifications if empty
  const imgOrdCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM imaging_orders');
  if (Number(imgOrdCount?.cnt || 0) === 0) {
    const amira = await queryOne<{ id: number }>("SELECT id FROM patients WHERE mrn = 'C360-000096'");
    const v1 = await queryOne<{ id: number }>("SELECT id FROM visits WHERE visit_number = 'VIS-26-000099'");
    const doc = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = 'doc@clinic360.local'");
    const cxr = await queryOne<{ id: number }>("SELECT id FROM imaging_catalog WHERE code = 'IMG-CXR'");
    const inv2 = await queryOne<{ id: number }>("SELECT id FROM invoices WHERE invoice_number = 'INV-26-000100'");
    if (amira && v1 && doc && cxr) {
      await execute(
        `INSERT INTO imaging_orders (visit_id, patient_id, catalog_id, invoice_id, ordered_by, clinical_question, status)
         VALUES (?, ?, ?, ?, ?, 'Rule out right lower lobe consolidation (productive cough, SpO2 91%)', 'ordered')`,
        [v1.id, amira.id, cxr.id, inv2?.id ?? null, doc.id]
      );
    }
  }

  const notifCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM notifications');
  if (Number(notifCount?.cnt || 0) === 0) {
    await execute(
      "INSERT INTO notifications (target_role, title, message, severity, entity_type) VALUES ('DOC', 'Urgent Triage Alert', 'Amira Kassahun (C360-000096) flagged SpO2 91% and Temp 38.6C in Triage.', 'critical', 'visit')"
    );
    await execute(
      "INSERT INTO notifications (target_role, title, message, severity, entity_type) VALUES ('ACC', 'Discount Approval Pending', 'Cashier David Kim requested $10.00 courtesy waiver on INV-26-000100.', 'warning', 'approval')"
    );
    await execute(
      "INSERT INTO notifications (target_role, title, message, severity, entity_type) VALUES ('WRD', 'Inpatient Medication Due', 'Evelyn Chen (GEN-101) has Lisinopril 10mg due at 20:00.', 'info', 'admission')"
    );
  }
}

async function seedInitialData() {
  const existingBranch = await queryOne<{ id: number }>('SELECT id FROM branches LIMIT 1');
  if (existingBranch) {
    await ensureExtraPermissionsAndSeeds();
    return;
  }

  await execute('INSERT INTO branches (code, name, address, phone) VALUES (?, ?, ?, ?)', [
    'MAIN', 'Clinic360 Central Medical Center', '420 Bole Medhanialem Ave, Suite 100', '+1 (555) 234-8900'
  ]);

  const departments = [
    ['OPD', 'Outpatient Department'],
    ['TRIAGE', 'Triage & Nursing'],
    ['LAB', 'Clinical Laboratory'],
    ['IMG', 'Diagnostic Imaging'],
    ['PHA', 'Dispensary Pharmacy'],
    ['FIN', 'Cashier & Finance'],
    ['ADM', 'Administration'],
  ];
  for (const [code, name] of departments) {
    await execute('INSERT INTO departments (branch_id, code, name) VALUES (1, ?, ?)', [code, name]);
  }

  const roles = [
    ['ADM', 'System Administrator', 'Users, roles, settings, master data, backups. No clinical or financial entry by default'],
    ['MGR', 'Medical Director / Manager', 'Read all dashboards and reports, approve high-value actions'],
    ['REC', 'Receptionist', 'Patient registration, appointments, queue'],
    ['CSH', 'Cashier', 'Collect payments, issue receipts, refunds (with approval), shift closing'],
    ['NUR', 'Triage / OPD Nurse', 'Vitals, triage, OPD nursing notes, injections and dressings'],
    ['DOC', 'Doctor', 'Consultation, orders, prescriptions, admission, discharge'],
    ['WRD', 'Ward Nurse', 'Inpatient nursing care, medication administration, bed management'],
    ['LAB', 'Laboratory Technician', 'Sample handling, test results, lab stock requests'],
    ['IMG', 'Imaging Technician', 'X-ray, ultrasound and other scans, image reports'],
    ['PHA', 'Pharmacist', 'Dispense, drug stock in dispensary, drug returns'],
    ['STO', 'Store Keeper', 'Main store, receiving, issuing, stock counts, purchase requests'],
    ['ACC', 'Accountant / Finance', 'Ledgers, expenses, receivables, payables, financial reports, approvals'],
    ['HRO', 'HR Officer', 'Staff records, attendance, leave, payroll, contracts'],
    ['AUD', 'Auditor', 'Read-only access to finance, stock and the audit log'],
  ];
  const roleIdByCode: Record<string, number> = {};
  for (const [code, name, description] of roles) {
    const res = await execute('INSERT INTO roles (code, name, description) VALUES (?, ?, ?)', [code, name, description]);
    roleIdByCode[code] = res.insertId;
  }

  const permissions = [
    ['patient.create', 'Registration', 'Create patient record'],
    ['patient.read', 'Registration', 'View patient demographics'],
    ['patient.clinical.read', 'Clinical', 'View clinical allergies, blood group, and medical notes'],
    ['patient.update', 'Registration', 'Edit patient record'],
    ['patient.merge', 'Registration', 'Merge duplicate patient records'],
    ['queue.manage', 'Queue', 'Issue queue tickets and update queue status'],
    ['appointment.create', 'Appointments', 'Book appointments'],
    ['appointment.read', 'Appointments', 'View appointment schedules'],
    ['appointment.update', 'Appointments', 'Reschedule, cancel, check-in appointments'],
    ['vitals.create', 'Triage', 'Record patient vitals and triage category'],
    ['vitals.read', 'Triage', 'View patient vitals'],
    ['visit.create', 'OPD', 'Start OPD visit'],
    ['visit.read', 'OPD', 'View OPD visits and consultation notes'],
    ['visit.update', 'OPD', 'Edit open consultation notes and diagnosis'],
    ['visit.close', 'OPD', 'Close and lock visit'],
    ['visit.reopen', 'OPD', 'Approve reopening a closed visit'],
    ['order.lab.create', 'OPD', 'Order laboratory tests'],
    ['prescription.create', 'OPD', 'Prescribe medications'],
    ['lab.order.read', 'Laboratory', 'View lab worklist'],
    ['lab.sample.collect', 'Laboratory', 'Collect lab sample'],
    ['lab.result.enter', 'Laboratory', 'Enter lab test results'],
    ['lab.result.verify', 'Laboratory', 'Verify and release lab results'],
    ['pharmacy.prescription.read', 'Pharmacy', 'View prescription queue'],
    ['pharmacy.dispense', 'Pharmacy', 'Dispense paid prescriptions'],
    ['billing.invoice.create', 'Cashier', 'Create patient invoices'],
    ['billing.invoice.read', 'Cashier', 'View invoices and payment status'],
    ['billing.payment.create', 'Cashier', 'Collect payments and issue receipts'],
    ['billing.shift.manage', 'Cashier', 'Open and close own cashier shift'],
    ['billing.approval.request', 'Cashier', 'Request discount, waiver, or void/refund'],
    ['billing.approval.decide', 'Finance', 'Approve or reject discount, refund, or void requests'],
    ['finance.report.view', 'Finance', 'View financial reconciliation and revenue reports'],
    ['admin.user.manage', 'Administration', 'Create, update, and deactivate user accounts'],
    ['admin.role.manage', 'Administration', 'View and manage role permission matrix'],
    ['audit.read', 'Audit', 'View tamper-evident audit logs'],
  ];
  const permIdByCode: Record<string, number> = {};
  for (const [code, module, description] of permissions) {
    const res = await execute('INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)', [code, module, description]);
    permIdByCode[code] = res.insertId;
  }

  const roleMatrix: Record<string, string[]> = {
    ADM: ['patient.read', 'patient.merge', 'admin.user.manage', 'admin.role.manage', 'audit.read'],
    MGR: [
      'patient.read', 'patient.clinical.read', 'appointment.read', 'vitals.read', 'visit.read', 'visit.reopen',
      'lab.order.read', 'pharmacy.prescription.read', 'billing.invoice.read', 'billing.approval.decide',
      'finance.report.view', 'admin.role.manage', 'audit.read'
    ],
    REC: [
      'patient.create', 'patient.read', 'patient.update', 'queue.manage',
      'appointment.create', 'appointment.read', 'appointment.update', 'billing.invoice.read', 'visit.create'
    ],
    CSH: [
      'patient.read', 'billing.invoice.create', 'billing.invoice.read', 'billing.payment.create',
      'billing.shift.manage', 'billing.approval.request'
    ],
    NUR: [
      'patient.read', 'patient.clinical.read', 'queue.manage', 'appointment.read', 'appointment.update',
      'vitals.create', 'vitals.read', 'visit.read', 'visit.create', 'lab.order.read'
    ],
    DOC: [
      'patient.read', 'patient.clinical.read', 'patient.update', 'appointment.read', 'appointment.update',
      'vitals.create', 'vitals.read', 'visit.create', 'visit.read', 'visit.update', 'visit.close',
      'order.lab.create', 'prescription.create', 'lab.order.read', 'pharmacy.prescription.read'
    ],
    WRD: ['patient.read', 'patient.clinical.read', 'vitals.create', 'vitals.read', 'visit.read', 'lab.order.read'],
    LAB: ['patient.read', 'lab.order.read', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify', 'visit.read'],
    IMG: ['patient.read', 'visit.read'],
    PHA: ['patient.read', 'patient.clinical.read', 'pharmacy.prescription.read', 'pharmacy.dispense', 'visit.read'],
    STO: ['pharmacy.prescription.read'],
    ACC: ['billing.invoice.read', 'billing.approval.decide', 'finance.report.view'],
    HRO: ['admin.user.manage'],
    AUD: [
      'patient.read', 'appointment.read', 'vitals.read', 'visit.read', 'lab.order.read',
      'pharmacy.prescription.read', 'billing.invoice.read', 'finance.report.view', 'audit.read'
    ],
  };

  for (const [roleCode, permCodes] of Object.entries(roleMatrix)) {
    const rId = roleIdByCode[roleCode];
    for (const pCode of permCodes) {
      const pId = permIdByCode[pCode];
      if (rId && pId) {
        const scope = roleCode === 'CSH' ? 'own' : 'all';
        await execute('INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?)', [rId, pId, scope]);
      }
    }
  }

  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['MRN', 'C360-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['VISIT', 'VIS-26-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['INV', 'INV-26-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['RCP', 'RCP-26-', 100]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['TICKET', 'Q-', 10]);
  await execute('INSERT INTO sequences (seq_key, prefix, current_value) VALUES (?, ?, ?)', ['ADM', 'ADM-26-', 10]);

  const demoPasswordHash = await bcrypt.hash('Clinic360!', 10);

  const demoUsers: Array<{ name: string; email: string; role: string; specialty?: string }> = [
    { name: 'Dr. Elena Vance', email: 'doc@clinic360.local', role: 'DOC', specialty: 'Internal Medicine' },
    { name: 'Dr. Samuel Bekele', email: 'doc2@clinic360.local', role: 'DOC', specialty: 'Pediatrics & Family Care' },
    { name: 'Maya Lin', email: 'rec@clinic360.local', role: 'REC' },
    { name: 'Clara Ortiz, RN', email: 'nur@clinic360.local', role: 'NUR' },
    { name: 'David Kim', email: 'csh@clinic360.local', role: 'CSH' },
    { name: 'Tariq Hassan', email: 'lab@clinic360.local', role: 'LAB' },
    { name: 'Nadia Patel, PharmD', email: 'pha@clinic360.local', role: 'PHA' },
    { name: 'Arthur Pendelton', email: 'acc@clinic360.local', role: 'ACC' },
    { name: 'Dr. Marcus Thorne', email: 'mgr@clinic360.local', role: 'MGR', specialty: 'Medical Director' },
    { name: 'Hannah Brooks', email: 'adm@clinic360.local', role: 'ADM' },
    { name: 'Victor Alvarez', email: 'aud@clinic360.local', role: 'AUD' },
  ];

  const userIds: Record<string, number> = {};
  for (const u of demoUsers) {
    const res = await execute(
      'INSERT INTO users (branch_id, full_name, email, password_hash, specialty) VALUES (1, ?, ?, ?, ?)',
      [u.name, u.email, demoPasswordHash, u.specialty ?? null]
    );
    userIds[u.email] = res.insertId;
    await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [
      res.insertId,
      roleIdByCode[u.role],
    ]);
  }

  const services = [
    ['REG-CARD', 'New Patient Registration Card', 'registration', 15.00],
    ['OPD-CONS', 'General Outpatient Consultation', 'consultation', 45.00],
    ['OPD-SPEC', 'Specialist Consultation', 'consultation', 75.00],
    ['OPD-FU', 'Follow-up Consultation', 'consultation', 25.00],
    ['NUR-INJ', 'Intramuscular Injection & Dressing', 'procedure', 18.00],
    ['NUR-NEB', 'Nebulization Therapy', 'procedure', 22.00],
    ['IMG-XRAY', 'Chest X-Ray (PA & Lateral)', 'imaging', 65.00],
    ['IMG-US', 'Abdominal Ultrasound', 'imaging', 90.00],
  ];
  for (const [code, name, cat, price] of services) {
    await execute('INSERT INTO services (code, name, category, unit_price) VALUES (?, ?, ?, ?)', [code, name, cat, price]);
  }

  const labTests = [
    ['LAB-CBC', 'Complete Blood Count (CBC)', 'Whole Blood (EDTA)', '10^9/L', '4.0 - 11.0 WBC', 32.00, 45],
    ['LAB-BMP', 'Basic Metabolic Panel (BMP)', 'Serum', 'mmol/L', '3.9 - 5.5 Glucose', 44.00, 60],
    ['LAB-HBA1C', 'Hemoglobin A1c', 'Whole Blood', '%', '4.0 - 5.6', 38.00, 90],
    ['LAB-UA', 'Urinalysis Complete', 'Urine', 'Qualitative', 'Negative Nitrite/Leuk', 18.00, 30],
    ['LAB-LFT', 'Liver Function Panel (LFT)', 'Serum', 'U/L', '7 - 56 ALT', 52.00, 75],
  ];
  for (const [code, name, sample, unit, ref, price, tat] of labTests) {
    await execute(
      'INSERT INTO lab_tests (code, name, sample_type, unit, reference_range, price, turnaround_mins) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [code, name, sample, unit, ref, price, tat]
    );
  }

  const medicines = [
    ['MED-AMOX', 'Amoxicillin', '500mg', 'Capsule', 12.50, 240, 40, 'BCH-2604A', '2027-08-30'],
    ['MED-PARA', 'Paracetamol (Acetaminophen)', '500mg', 'Tablet', 4.50, 520, 100, 'BCH-2602C', '2027-11-15'],
    ['MED-METF', 'Metformin HCl', '850mg', 'Tablet', 16.00, 185, 50, 'BCH-2601K', '2027-05-20'],
    ['MED-LISI', 'Lisinopril', '10mg', 'Tablet', 19.00, 140, 30, 'BCH-2603M', '2027-09-12'],
    ['MED-AZIT', 'Azithromycin', '250mg', 'Tablet', 22.00, 34, 40, 'BCH-2511R', '2027-01-30'],
    ['MED-SALB', 'Salbutamol Inhaler', '100mcg', 'Inhaler', 28.00, 48, 15, 'BCH-2605P', '2028-02-28'],
  ];
  for (const [code, gen, str, form, price, stock, reorder, batch, exp] of medicines) {
    await execute(
      'INSERT INTO medicines (code, generic_name, strength, form, unit_price, stock_qty, reorder_level, batch_number, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [code, gen, str, form, price, stock, reorder, batch, exp]
    );
  }

  const patients = [
    ['C360-000096', 'Amira', 'Kassahun', 'Female', '1989-04-12', '+1-555-0142', 'amira.k@example.com', '142 Oakwood Ln', 'Dawit Kassahun', '+1-555-0199', 'O+', 'Penicillin (rash)', 'self-pay', null, null],
    ['C360-000097', 'Marcus', 'Sterling', 'Male', '1974-09-28', '+1-555-0188', 'm.sterling@example.com', '88 Maple Terrace', 'Claire Sterling', '+1-555-0189', 'A+', 'None known', 'insurance', 'Aetna Health Plan', 'AET-884920'],
    ['C360-000098', 'Sofia', 'Mendoza', 'Female', '1995-02-05', '+1-555-0163', 'sofia.m@example.com', '310 Pine Street', 'Carlos Mendoza', '+1-555-0164', 'B+', 'Sulfa drugs', 'self-pay', null, null],
    ['C360-000099', 'Liam', 'OConnor', 'Male', '2018-11-14', '+1-555-0171', null, '54 Cedar Court', 'Fiona OConnor', '+1-555-0172', 'O-', 'None known', 'credit', 'Global Care NGO', 'GC-2026-14'],
    ['C360-000100', 'Evelyn', 'Chen', 'Female', '1963-07-19', '+1-555-0155', 'echen@example.com', '719 Birch Blvd', 'Alan Chen', '+1-555-0156', 'AB+', 'Aspirin (bronchospasm)', 'insurance', 'BlueCross Shield', 'BC-992104'],
  ];
  const patientIds: number[] = [];
  for (const p of patients) {
    const res = await execute(
      `INSERT INTO patients (mrn, first_name, last_name, sex, date_of_birth, phone, email, address, next_of_kin_name, next_of_kin_phone, blood_group, allergies, patient_type, payer_name, insurance_number, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...p, userIds['rec@clinic360.local']]
    );
    patientIds.push(res.insertId);
  }

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const appts = [
    [patientIds[0], userIds['doc@clinic360.local'], today, '09:00', '09:30', 'consultation', 'Persistent cough and low-grade fever', 'checked_in'],
    [patientIds[1], userIds['doc@clinic360.local'], today, '09:30', '10:00', 'follow-up', 'Hypertension & HbA1c lab review', 'checked_in'],
    [patientIds[2], userIds['doc@clinic360.local'], today, '10:30', '11:00', 'consultation', 'Acute migraine episodes', 'scheduled'],
    [patientIds[3], userIds['doc2@clinic360.local'], today, '11:00', '11:30', 'checkup', 'Pediatric annual wellness & asthma check', 'scheduled'],
    [patientIds[4], userIds['doc@clinic360.local'], tomorrow, '09:00', '09:30', 'follow-up', 'Post-discharge cardiology follow-up', 'scheduled'],
  ];
  for (const a of appts) {
    await execute(
      `INSERT INTO appointments (patient_id, doctor_id, appointment_date, start_time, end_time, visit_type, reason, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...a, userIds['rec@clinic360.local']]
    );
  }

  const shiftRes = await execute(
    'INSERT INTO cashier_shifts (cashier_id, opening_float, expected_cash, status) VALUES (?, 200.00, 245.00, ?)',
    [userIds['csh@clinic360.local'], 'open']
  );

  const v1 = await execute(
    `INSERT INTO visits (visit_number, patient_id, doctor_id, triage_priority, chief_complaint, history_notes, exam_notes, diagnosis_code, diagnosis_text, treatment_plan, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'VIS-26-000099', patientIds[0], userIds['doc@clinic360.local'], 'urgent',
      'Productive cough x 4 days, mild dyspnea',
      'Non-smoker, fever 38.4C at home. Allergic to Penicillin.',
      'Scattered rhonchi right lower zone, alert and oriented.',
      'J20.9', 'Acute Bronchitis', 'Order CBC, Chest X-Ray, dispense Azithromycin (avoid beta-lactams due to Penicillin allergy).',
      'in_consultation', userIds['nur@clinic360.local']
    ]
  );

  await execute(
    `INSERT INTO vitals (visit_id, patient_id, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight_kg, height_cm, bmi, early_warning_flag, notes, recorded_by)
     VALUES (?, ?, 128, 82, 38.6, 98, 22, 91, 64.0, 165.0, 23.5, 1, 'SpO2 91% on room air - flagged for urgent review', ?)`,
    [v1.insertId, patientIds[0], userIds['nur@clinic360.local']]
  );

  const v2 = await execute(
    `INSERT INTO visits (visit_number, patient_id, doctor_id, triage_priority, chief_complaint, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['VIS-26-000100', patientIds[1], userIds['doc@clinic360.local'], 'routine', 'BP check and metabolic lab follow-up', 'triage', userIds['rec@clinic360.local']]
  );

  await execute(
    `INSERT INTO vitals (visit_id, patient_id, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight_kg, height_cm, bmi, blood_glucose, early_warning_flag, recorded_by)
     VALUES (?, ?, 138, 88, 36.7, 74, 16, 98, 84.5, 178.0, 26.7, 118.0, 0, ?)`,
    [v2.insertId, patientIds[1], userIds['nur@clinic360.local']]
  );

  await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['Q-000008', 'OPD', patientIds[0], v1.insertId, 'urgent', 'in_service', userIds['rec@clinic360.local']]
  );
  await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['Q-000009', 'OPD', patientIds[1], v2.insertId, 'routine', 'waiting', userIds['rec@clinic360.local']]
  );
  await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, priority, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    ['Q-000010', 'LAB', patientIds[0], 'urgent', 'waiting', userIds['rec@clinic360.local']]
  );

  const inv1 = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, 'self-pay', 45.00, 0.00, 45.00, 45.00, 'paid', ?)`,
    ['INV-26-000099', patientIds[0], v1.insertId, userIds['csh@clinic360.local']]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 45.00, 45.00)',
    [inv1.insertId, 'OPD-CONS', 'General Outpatient Consultation', 'consultation']
  );

  const pay1 = await execute(
    `INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, created_by)
     VALUES (?, ?, ?, 45.00, 'cash', 'CSH-9901', ?)`,
    [inv1.insertId, patientIds[0], shiftRes.insertId, userIds['csh@clinic360.local']]
  );
  await execute(
    `INSERT INTO receipts (receipt_number, payment_id, invoice_id, patient_id, amount, payment_method, issued_by)
     VALUES (?, ?, ?, ?, 45.00, 'cash', ?)`,
    ['RCP-26-000099', pay1.insertId, inv1.insertId, patientIds[0], userIds['csh@clinic360.local']]
  );

  const inv2 = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, 'self-pay', 54.00, 0.00, 54.00, 0.00, 'unpaid', ?)`,
    ['INV-26-000100', patientIds[0], v1.insertId, userIds['doc@clinic360.local']]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 32.00, 32.00)',
    [inv2.insertId, 'LAB-CBC', 'Complete Blood Count (CBC)', 'lab']
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, 22.00, 22.00)',
    [inv2.insertId, 'MED-AZIT', 'Azithromycin 250mg Tablet', 'pharmacy']
  );

  const cbcRow = await queryOne<{ id: number }>('SELECT id FROM lab_tests WHERE code = ?', ['LAB-CBC']);
  const azitRow = await queryOne<{ id: number }>('SELECT id FROM medicines WHERE code = ?', ['MED-AZIT']);
  if (cbcRow) {
    await execute(
      'INSERT INTO lab_orders (visit_id, patient_id, test_id, invoice_id, ordered_by, status) VALUES (?, ?, ?, ?, ?, ?)',
      [v1.insertId, patientIds[0], cbcRow.id, inv2.insertId, userIds['doc@clinic360.local'], 'ordered']
    );
  }
  if (azitRow) {
    const rx = await execute(
      'INSERT INTO prescriptions (visit_id, patient_id, doctor_id, invoice_id, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [v1.insertId, patientIds[0], userIds['doc@clinic360.local'], inv2.insertId, 'pending', 'Patient allergic to Penicillin; macrolide selected']
    );
    await execute(
      'INSERT INTO prescription_items (prescription_id, medicine_id, dosage, frequency, duration_days, quantity, instructions) VALUES (?, ?, ?, ?, 5, 1, ?)',
      [rx.insertId, azitRow.id, '500mg day 1 then 250mg', 'Once daily', 'Take with or without food']
    );
  }

  await execute(
    `INSERT INTO approval_requests (request_type, entity_type, entity_id, requested_amount, reason, status, requested_by)
     VALUES ('discount', 'invoice', ?, 10.00, 'Senior citizen courtesy waiver requested at desk', 'pending', ?)`,
    [inv2.insertId, userIds['csh@clinic360.local']]
  );

  const genesisPayload = JSON.stringify({
    occurred_at: new Date().toISOString(),
    user_id: userIds['adm@clinic360.local'],
    action: 'system.bootstrap',
    entity_type: 'system',
    entity_id: 'clinic360',
    prev_hash: 'GENESIS',
  });
  const rowHash = crypto.createHash('sha256').update(genesisPayload).digest('hex');
  await execute(
    `INSERT INTO audit_logs (user_id, user_name, role_at_time, action, entity_type, entity_id, after_json, reason, ip_address, prev_hash, row_hash)
     VALUES (?, 'Hannah Brooks', 'ADM', 'system.bootstrap', 'system', 'clinic360', ?, 'Initial Clinic360 database seed', '127.0.0.1', 'GENESIS', ?)`,
    [userIds['adm@clinic360.local'], JSON.stringify({ roles: 14, users: demoUsers.length }), rowHash]
  );

  await ensureExtraPermissionsAndSeeds();
}

export async function initDatabase(): Promise<{ dialect: DbDialect }> {
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  const port = Number(process.env.MYSQL_PORT || 3306);

  if (host && user && database && host !== '127.0.0.1' && password !== 'change_me') {
    try {
      mysqlPool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
      });
      await mysqlPool.query('SELECT 1');
      activeDialect = 'mysql';
      console.log(`[Clinic360] Connected to MySQL (${host}:${port}/${database})`);
      await seedInitialData();
      return { dialect: 'mysql' };
    } catch (err) {
      console.warn('[Clinic360] MySQL connection unavailable, falling back to embedded SQLite:', (err as Error).message);
      mysqlPool = null;
    }
  }

  const dbPath = path.resolve(process.cwd(), 'clinic360.db');
  sqliteDb = new Database(dbPath);
  activeDialect = 'sqlite';
  await initSqliteSchema(sqliteDb);
  await seedInitialData();
  console.log(`[Clinic360] Database ready (${activeDialect} at ${dbPath})`);
  return { dialect: 'sqlite' };
}
