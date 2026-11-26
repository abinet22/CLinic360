import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CreditCard, Edit2, Eye, GitMerge, Lock, Megaphone, Plus, Receipt, Search, Stethoscope, UserPlus, X } from 'lucide-react';
import { ApiError, apiFetch } from '../lib/api';
import { useRealtimeSync } from '../lib/useRealtimeSync';
import type { CashierShift, Patient, QueueTicket, ServiceItem, UserContext, Visit } from '../types';

interface DoctorOption {
  id: number;
  full_name: string;
  specialty: string | null;
}

interface PatientsQueueViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  initialSubTab?: 'patients' | 'register' | 'visits' | 'assign_doctor' | 'queue';
}

interface PatientDetailPayload {
  patient: Patient;
  clinicalMasked: boolean;
  assignedDoctorIds?: number[];
  appointments: Array<{ id: number; appointment_date: string; start_time: string; doctor_name: string; status: string }>;
  visits: Array<{ id: number; visit_number: string; diagnosis_text: string | null; status: string; created_at: string; doctor_name: string | null }>;
  vitals: Array<{ id: number; bp_systolic: number | null; bp_diastolic: number | null; temperature: number | null; spo2: number | null; recorded_at: string }>;
  invoices: Array<{ id: number; invoice_number: string; total_amount: number; paid_amount: number; status: string; created_at: string }>;
  accessHistory: Array<{ id: number; occurred_at: string; user_name: string; role_at_time: string; action: string }>;
}

export const PatientsQueueView: React.FC<PatientsQueueViewProps> = ({ user, onNotify, initialSubTab }) => {
  const [subTab, setSubTab] = useState<'patients' | 'visits' | 'assign_doctor' | 'queue'>(
    initialSubTab && initialSubTab !== 'register' ? initialSubTab : 'patients'
  );
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [lookupField, setLookupField] = useState<'all' | 'name' | 'phone' | 'mrn'>('all');
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientTotal, setPatientTotal] = useState(0);
  const [patientPage, setPatientPage] = useState(1);
  const [clinicalMasked, setClinicalMasked] = useState(false);
  const [tickets, setTickets] = useState<QueueTicket[]>([]);
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [assignDoctorSelections, setAssignDoctorSelections] = useState<Record<number, string>>({});
  const [assigningVisitId, setAssigningVisitId] = useState<number | null>(null);

  const [showRegister, setShowRegister] = useState(false);
  const [duplicates, setDuplicates] = useState<Array<{ id: number; mrn: string; first_name: string; last_name: string; phone: string }>>([]);
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    sex: 'Female',
    date_of_birth: '1992-05-14',
    phone: '',
    email: '',
    address: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
    blood_group: 'O+',
    allergies: 'None known',
    patient_type: 'self-pay',
    payer_name: '',
    insurance_number: '',
    dob_estimated: false,
    issue_queue_ticket: true,
    charge_registration_card: true,
  });

  const [selectedDetail, setSelectedDetail] = useState<PatientDetailPayload | null>(null);
  const [breakGlassPending, setBreakGlassPending] = useState<PatientDetailPayload | null>(null);
  const [breakGlassReason, setBreakGlassReason] = useState('');
  const [breakGlassCleared, setBreakGlassCleared] = useState<Record<number, string>>({});
  const [showMerge, setShowMerge] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeReason, setMergeReason] = useState('');

  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [consultServices, setConsultServices] = useState<ServiceItem[]>([]);
  const [showCreateVisit, setShowCreateVisit] = useState(false);
  const [visitPatient, setVisitPatient] = useState<Patient | null>(null);
  const [visitPatientSearch, setVisitPatientSearch] = useState('');
  const [submittingVisit, setSubmittingVisit] = useState(false);
  const [visitForm, setVisitForm] = useState({
    visit_type: 'walk_in',
    specialty: 'General Medicine',
    service_code: 'CON-GEN',
    doctor_id: '',
    triage_priority: 'routine',
    queue_department: 'TRIAGE',
    chief_complaint: '',
    generate_consultation_invoice: true,
  });
  const [lastCreatedVisit, setLastCreatedVisit] = useState<{
    patientName: string;
    mrn: string;
    visitNumber: string;
    ticketNumber: string;
    queueDepartment: string;
    consultationInvoiceNumber: string | null;
    consultationInvoiceStatus: string | null;
    receiptNumber: string | null;
    consultationFee: number;
    workflowStage: string;
  } | null>(null);
  const [openVisitAfterRegister, setOpenVisitAfterRegister] = useState(false);
  const [hasOpenShift, setHasOpenShift] = useState(false);
  const [openingShiftInline, setOpeningShiftInline] = useState(false);
  const [collectPaymentNow, setCollectPaymentNow] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'mobile_money' | 'bank_transfer'>('cash');
  const [paymentReference, setPaymentReference] = useState('');

  const [editTarget, setEditTarget] = useState<Patient | null>(null);
  const [editForm, setEditForm] = useState({
    first_name: '',
    last_name: '',
    sex: 'Female',
    date_of_birth: '',
    phone: '',
    email: '',
    address: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
    blood_group: 'Unknown',
    allergies: 'None known',
    patient_type: 'self-pay',
    payer_name: '',
    insurance_number: '',
    national_id: '',
    identity_change_reason: '',
    payer_change_reason: '',
  });

  const canCreate = user.permissions.includes('patient.create');
  const canUpdatePatient = user.permissions.includes('patient.update');
  const canClinicalRead = user.permissions.includes('patient.clinical.read');
  const canCreateVisit = user.permissions.includes('visit.create');
  const canQueue = user.permissions.includes('queue.manage');
  const canMerge = user.permissions.includes('patient.merge');
  const canCollectPayment = user.permissions.includes('billing.payment.create');
  const canManageShift = user.permissions.includes('billing.shift.manage');
  const canAssignDoctor =
    user.permissions.includes('visit.assign_doctor') ||
    canCreateVisit ||
    user.permissions.includes('vitals.create') ||
    canQueue;
  const canReadVisits = user.permissions.includes('visit.read') || canAssignDoctor;

  useEffect(() => {
    if (!search.trim()) {
      setDebouncedSearch('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 180);
    return () => clearTimeout(timer);
  }, [search]);

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ patients: Patient[]; total?: number; clinicalMasked: boolean }>(
        `/api/patients?search=${encodeURIComponent(debouncedSearch)}&field=${encodeURIComponent(lookupField)}&page=${patientPage}&limit=25`
      );
      setPatients(res.patients || []);
      setPatientTotal(typeof res.total === 'number' ? res.total : (res.patients || []).length);
      setClinicalMasked(res.clinicalMasked);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, lookupField, patientPage, onNotify]);

  const loadQueue = useCallback(async () => {
    try {
      const res = await apiFetch<{ tickets: QueueTicket[] }>(`/api/queue?department=${deptFilter}`);
      setTickets(res.tickets);
    } catch {
      // ignore if role doesn't have queue access
    }
  }, [deptFilter]);

  const loadCashierShift = useCallback(async () => {
    if (!canCollectPayment) return;
    try {
      const res = await apiFetch<{ shifts: CashierShift[] }>('/api/billing/shifts');
      const open = (res.shifts || []).some((s) => s.cashier_id === user.id && s.status === 'open');
      setHasOpenShift(open);
    } catch {
      // ignore
    }
  }, [canCollectPayment, user.id]);

  const loadVisits = useCallback(async () => {
    if (!canReadVisits) return;
    setVisitsLoading(true);
    try {
      const res = await apiFetch<{ visits: Visit[] }>('/api/visits');
      const list = res.visits || [];
      setVisits(list);
      setAssignDoctorSelections((prev) => {
        const next = { ...prev };
        for (const v of list) {
          if (!next[v.id]) {
            next[v.id] = v.doctor_id ? String(v.doctor_id) : doctors[0] ? String(doctors[0].id) : '';
          }
        }
        return next;
      });
    } catch {
      // ignore if role lacks visit.read
    } finally {
      setVisitsLoading(false);
    }
  }, [canReadVisits, doctors]);

  useEffect(() => {
    loadPatients();
  }, [loadPatients]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    loadCashierShift();
  }, [loadCashierShift]);

  useEffect(() => {
    loadVisits();
  }, [loadVisits]);

  useEffect(() => {
    if (initialSubTab === 'register') {
      setSubTab('patients');
      setShowRegister(true);
    } else if (initialSubTab) {
      setSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  useEffect(() => {
    if (canCreateVisit || canAssignDoctor) {
      apiFetch<{ doctors: DoctorOption[] }>('/api/doctors')
        .then((res) => {
          setDoctors(res.doctors || []);
          if (res.doctors[0]) {
            setVisitForm((prev) => (prev.doctor_id ? prev : { ...prev, doctor_id: String(res.doctors[0].id) }));
          }
        })
        .catch(() => {});
      apiFetch<{ services: ServiceItem[] }>('/api/catalog/services')
        .then((res) => {
          const consults = (res.services || []).filter((s) => s.category === 'consultation');
          setConsultServices(consults);
        })
        .catch(() => {});
    }
  }, [canCreateVisit, canAssignDoctor]);

  useRealtimeSync(['queue:updated', 'visit:updated', 'payment:confirmed'], () => {
    loadPatients();
    loadQueue();
    loadCashierShift();
    loadVisits();
  });

  async function checkDuplicates() {
    if (!form.first_name && !form.phone) return;
    try {
      const params = new URLSearchParams({
        first_name: form.first_name,
        last_name: form.last_name,
        date_of_birth: form.date_of_birth,
        phone: form.phone,
      });
      const res = await apiFetch<{ duplicates: typeof duplicates }>(`/api/patients/check-duplicate?${params}`);
      setDuplicates(res.duplicates);
    } catch {
      // ignore
    }
  }

  function defaultServiceCodeFor(specialty: string, visitType: string): string {
    if (visitType === 'follow_up') return 'OPD-FU';
    const s = specialty.toLowerCase();
    if (s.includes('pediat')) return 'CON-PED';
    if (s.includes('gyn')) return 'CON-GYN';
    if (s.includes('derm')) return 'CON-DERM';
    return 'CON-GEN';
  }

  function openCreatePatientFromLookup(prefillQuery?: string) {
    const q = (prefillQuery || '').trim();
    const isPhoneQuery = lookupField === 'phone' || /^[+\d\s\-()]{3,}$/.test(q);
    const isMrnQuery = lookupField === 'mrn' || /^c360-/i.test(q);
    let firstName = '';
    let lastName = '';
    let phone = '';
    if (q && isPhoneQuery) {
      phone = q;
    } else if (q && !isMrnQuery && /[a-z]/i.test(q)) {
      const parts = q.split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }
    setDuplicates([]);
    setForm((prev) => ({
      ...prev,
      first_name: firstName,
      last_name: lastName,
      phone,
    }));
    setShowRegister(true);
  }

  function openCreateVisitModal(patient?: Patient | null) {
    const target = patient ?? patients[0] ?? null;
    const defaultSpecialty = 'General Medicine';
    const matchedDoc =
      doctors.find((d) => (d.specialty || '').toLowerCase().includes('general')) || doctors[0] || null;
    setVisitPatient(target);
    setVisitPatientSearch('');
    setCollectPaymentNow(canCollectPayment && hasOpenShift);
    setPaymentMethod('cash');
    setPaymentReference('');
    setVisitForm({
      visit_type: 'walk_in',
      specialty: defaultSpecialty,
      service_code: defaultServiceCodeFor(defaultSpecialty, 'walk_in'),
      doctor_id: matchedDoc ? String(matchedDoc.id) : '',
      triage_priority: 'routine',
      queue_department: 'TRIAGE',
      chief_complaint: '',
      generate_consultation_invoice: target ? target.patient_type !== 'exempt' : true,
    });
    setShowCreateVisit(true);
  }

  async function handleCreatePatient(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload = openVisitAfterRegister ? { ...form, issue_queue_ticket: false } : form;
      const res = await apiFetch<{ patient: Patient; ticketNumber: string | null }>('/api/patients', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onNotify(
        `Registered ${res.patient.first_name} ${res.patient.last_name} (${res.patient.mrn})${res.ticketNumber ? ` · Queue ${res.ticketNumber}` : ''}`,
        'success'
      );
      setShowRegister(false);
      setDuplicates([]);
      setForm({
        ...form,
        first_name: '',
        last_name: '',
        phone: '',
        email: '',
        address: '',
        next_of_kin_name: '',
        next_of_kin_phone: '',
        payer_name: '',
        insurance_number: '',
      });
      await loadPatients();
      loadQueue();
      if (openVisitAfterRegister && canCreateVisit && res.patient) {
        setOpenVisitAfterRegister(false);
        openCreateVisitModal(res.patient);
      } else {
        setOpenVisitAfterRegister(false);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openEditPatient(p: Patient) {
    setEditTarget(p);
    setEditForm({
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      sex: p.sex || 'Female',
      date_of_birth: p.date_of_birth || '',
      phone: p.phone || '',
      email: p.email || '',
      address: p.address || '',
      next_of_kin_name: p.next_of_kin_name || '',
      next_of_kin_phone: p.next_of_kin_phone || '',
      blood_group: p.blood_group && p.blood_group !== 'Restricted' ? p.blood_group : 'Unknown',
      allergies: p.allergies && p.allergies !== 'Restricted' ? p.allergies : 'None known',
      patient_type: p.patient_type || 'self-pay',
      payer_name: p.payer_name || '',
      insurance_number: p.insurance_number && p.insurance_number !== 'Masked' ? p.insurance_number : '',
      national_id: p.national_id && p.national_id !== 'Masked' ? p.national_id : '',
      identity_change_reason: '',
      payer_change_reason: '',
    });
  }

  const editIdentityChanged = Boolean(
    editTarget &&
      (editForm.first_name !== (editTarget.first_name || '') ||
        editForm.last_name !== (editTarget.last_name || '') ||
        editForm.sex !== (editTarget.sex || 'Female') ||
        editForm.date_of_birth !== (editTarget.date_of_birth || '') ||
        (editForm.national_id || '') !==
          (editTarget.national_id && editTarget.national_id !== 'Masked' ? editTarget.national_id : ''))
  );

  const editPayerChanged = Boolean(
    editTarget &&
      (editForm.patient_type !== (editTarget.patient_type || 'self-pay') ||
        (editForm.payer_name || '') !== (editTarget.payer_name || '') ||
        (editForm.insurance_number || '') !==
          (editTarget.insurance_number && editTarget.insurance_number !== 'Masked'
            ? editTarget.insurance_number
            : ''))
  );

  async function handleUpdatePatient(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    if (editIdentityChanged && editForm.identity_change_reason.trim().length < 5) {
      onNotify('Identity changes require a formal reason (min 5 characters).', 'error');
      return;
    }
    if (editPayerChanged && editForm.payer_change_reason.trim().length < 5) {
      onNotify('Payer category changes require a documented reason (min 5 characters).', 'error');
      return;
    }
    try {
      const payload: Record<string, string | null> = {
        phone: editForm.phone,
        email: editForm.email || null,
        address: editForm.address || null,
        next_of_kin_name: editForm.next_of_kin_name || null,
        next_of_kin_phone: editForm.next_of_kin_phone || null,
      };
      if (editIdentityChanged) {
        payload.first_name = editForm.first_name;
        payload.last_name = editForm.last_name;
        payload.sex = editForm.sex;
        payload.date_of_birth = editForm.date_of_birth;
        if (editForm.national_id) payload.national_id = editForm.national_id;
        payload.identity_change_reason = editForm.identity_change_reason.trim();
      }
      if (editPayerChanged) {
        payload.patient_type = editForm.patient_type;
        payload.payer_name = editForm.payer_name || null;
        if (editForm.insurance_number) payload.insurance_number = editForm.insurance_number;
        payload.payer_change_reason = editForm.payer_change_reason.trim();
      }
      if (canClinicalRead) {
        payload.blood_group = editForm.blood_group;
        payload.allergies = editForm.allergies;
      }
      const res = await apiFetch<{ patient: Patient; pendingExemptApprovalId?: number | null }>(
        `/api/patients/${editTarget.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      );
      if (res.pendingExemptApprovalId) {
        onNotify(
          `Patient demographics updated · Fee exemption request #${res.pendingExemptApprovalId} sent for Manager approval.`,
          'success'
        );
      } else {
        onNotify(`Updated demographics for ${editForm.first_name} ${editForm.last_name}`, 'success');
      }
      const editedId = editTarget.id;
      setEditTarget(null);
      loadPatients();
      if (selectedDetail && selectedDetail.patient.id === editedId) {
        openPatientDetail(editedId);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function openPatientDetail(id: number) {
    try {
      const detail = await apiFetch<PatientDetailPayload>(`/api/patients/${id}`);
      const isDoc = user.roles.includes('DOC');
      const isAssigned = (detail.assignedDoctorIds || []).includes(user.id);
      if (isDoc && !detail.clinicalMasked && !isAssigned && !breakGlassCleared[id]) {
        setBreakGlassReason('');
        setBreakGlassPending(detail);
        return;
      }
      setSelectedDetail(detail);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.data?.breakGlassRequired) {
        const listMatch = patients.find((p) => p.id === id);
        const placeholderPatient: Patient = listMatch || {
          id,
          mrn: `ID-${id}`,
          first_name: 'Unassigned',
          last_name: 'Patient',
          sex: 'Other',
          date_of_birth: '',
          phone: '',
          email: null,
          address: null,
          patient_type: 'self-pay',
          payer_name: null,
          insurance_number: null,
          status: 'active',
          created_at: '',
        };
        setBreakGlassReason('');
        setBreakGlassPending({
          patient: placeholderPatient,
          clinicalMasked: true,
          appointments: [],
          visits: [],
          vitals: [],
          invoices: [],
          accessHistory: [],
        });
        return;
      }
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleConfirmBreakGlass(e: React.FormEvent) {
    e.preventDefault();
    if (!breakGlassPending) return;
    const reason = breakGlassReason.trim();
    if (reason.length < 8) {
      onNotify('Clinical justification must be at least 8 characters.', 'error');
      return;
    }
    const targetId = breakGlassPending.patient.id;
    try {
      await apiFetch(`/api/patients/${targetId}/break-glass`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setBreakGlassCleared((prev) => ({ ...prev, [targetId]: reason }));
      setBreakGlassPending(null);
      setBreakGlassReason('');
      const unlockedDetail = await apiFetch<PatientDetailPayload>(`/api/patients/${targetId}`);
      setSelectedDetail(unlockedDetail);
      onNotify('Break-Glass access logged and escalated to Auditor & Manager', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCallNextInDept() {
    if (deptFilter === 'ALL') return;
    try {
      const res = await apiFetch<{ ticket: QueueTicket }>(`/api/queue/${encodeURIComponent(deptFilter)}/call-next`, {
        method: 'POST',
      });
      onNotify(`Called ticket ${res.ticket.ticket_number} in ${deptFilter} queue`, 'success');
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function updateTicketStatus(ticketId: number, status?: string, priority?: string) {
    try {
      await apiFetch(`/api/queue/${ticketId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, priority }),
      });
      loadQueue();
      onNotify('Queue ticket updated', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function issueQuickTicket(patientId: number, department = 'OPD') {
    try {
      const res = await apiFetch<{ ticketNumber: string }>('/api/queue', {
        method: 'POST',
        body: JSON.stringify({ patient_id: patientId, department, priority: 'routine' }),
      });
      onNotify(`Issued queue ticket ${res.ticketNumber} (${department})`, 'success');
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const filteredVisitPatients = useMemo(() => {
    const q = visitPatientSearch.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.mrn.toLowerCase().includes(q) ||
        `${p.first_name} ${p.last_name}`.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q)
    );
  }, [patients, visitPatientSearch]);

  const selectedConsultService = useMemo(() => {
    return consultServices.find((s) => s.code === visitForm.service_code) || null;
  }, [consultServices, visitForm.service_code]);

  const willGenerateConsultInvoice = Boolean(
    visitPatient &&
      visitPatient.patient_type !== 'exempt' &&
      (visitForm.visit_type === 'walk_in' || visitForm.generate_consultation_invoice)
  );

  const cashierPayingUpfront = Boolean(
    canCollectPayment &&
      hasOpenShift &&
      collectPaymentNow &&
      visitPatient?.patient_type === 'self-pay' &&
      willGenerateConsultInvoice
  );

  const visitWillAwaitPayment = Boolean(
    visitPatient &&
      visitPatient.patient_type === 'self-pay' &&
      willGenerateConsultInvoice &&
      visitForm.triage_priority !== 'emergency' &&
      !cashierPayingUpfront
  );

  async function handleOpenQuickShift() {
    setOpeningShiftInline(true);
    try {
      await apiFetch('/api/billing/shifts/open', {
        method: 'POST',
        body: JSON.stringify({ opening_float: 200 }),
      });
      setHasOpenShift(true);
      setCollectPaymentNow(true);
      onNotify('Cashier shift opened ($200.00 float). Ready to collect walk-in payments.', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setOpeningShiftInline(false);
    }
  }

  async function handleQuickCollectAndTriage(ticket: QueueTicket) {
    if (!ticket.consultation_invoice_id) return;
    if (!hasOpenShift) {
      onNotify('Open a Cashier Shift first before collecting consultation payments.', 'error');
      return;
    }
    const balance = Number(
      (Number(ticket.consultation_total_amount || 45) - Number(ticket.consultation_paid_amount || 0)).toFixed(2)
    );
    try {
      const res = await apiFetch<{ receiptNumber: string }>('/api/billing/payments', {
        method: 'POST',
        body: JSON.stringify({
          invoice_id: ticket.consultation_invoice_id,
          amount: balance > 0 ? balance : 45,
          payment_method: 'cash',
        }),
      });
      onNotify(
        `Payment ${res.receiptNumber} collected · Ticket ${ticket.ticket_number} moved to TRIAGE queue`,
        'success'
      );
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleStartVisit(e: React.FormEvent) {
    e.preventDefault();
    if (!visitPatient) {
      onNotify('Please select a patient to create a visit.', 'error');
      return;
    }
    setSubmittingVisit(true);
    try {
      const res = await apiFetch<{
        visitNumber: string;
        workflowStage: string;
        queueDepartment: string;
        consultationFee: number;
        consultationInvoiceNumber: string | null;
        consultationInvoiceStatus: string | null;
        receiptNumber: string | null;
        ticketNumber: string;
      }>('/api/visits', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: visitPatient.id,
          doctor_id: visitForm.doctor_id ? Number(visitForm.doctor_id) : null,
          visit_type: visitForm.visit_type,
          specialty: visitForm.specialty,
          service_code: visitForm.service_code || undefined,
          triage_priority: visitForm.triage_priority,
          queue_department: visitWillAwaitPayment ? 'CSH' : visitForm.queue_department,
          chief_complaint: visitForm.chief_complaint || `${visitForm.specialty} walk-in consultation`,
          generate_consultation_invoice:
            visitPatient.patient_type === 'exempt'
              ? false
              : visitForm.visit_type === 'walk_in'
                ? true
                : visitForm.generate_consultation_invoice,
          collect_payment: cashierPayingUpfront,
          payment_method: paymentMethod,
          payment_reference: paymentReference.trim() || undefined,
        }),
      });
      const assignedDept = res.queueDepartment || (res.workflowStage === 'awaiting_payment' ? 'CSH' : 'TRIAGE');
      setLastCreatedVisit({
        patientName: `${visitPatient.first_name} ${visitPatient.last_name}`,
        mrn: visitPatient.mrn,
        visitNumber: res.visitNumber,
        ticketNumber: res.ticketNumber,
        queueDepartment: assignedDept,
        consultationInvoiceNumber: res.consultationInvoiceNumber,
        consultationInvoiceStatus: res.consultationInvoiceStatus,
        receiptNumber: res.receiptNumber || null,
        consultationFee: res.consultationFee || Number(selectedConsultService?.unit_price || 45),
        workflowStage: res.workflowStage,
      });
      onNotify(
        `Created ${res.visitNumber} · Ticket ${res.ticketNumber} added to ${assignedDept} queue${
          res.receiptNumber ? ` · Receipt ${res.receiptNumber}` : res.consultationInvoiceNumber ? ` · Invoice ${res.consultationInvoiceNumber}` : ''
        }`,
        'success'
      );
      setShowCreateVisit(false);
      setVisitPatient(null);
      setVisitForm((p) => ({ ...p, chief_complaint: '' }));
      loadQueue();
      loadPatients();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSubmittingVisit(false);
    }
  }

  async function handleMergePatients(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ mergedMrn: string; intoMrn: string }>('/api/patients/merge', {
        method: 'POST',
        body: JSON.stringify({
          source_patient_id: Number(mergeSourceId),
          target_patient_id: Number(mergeTargetId),
          reason: mergeReason,
        }),
      });
      onNotify(`Merged ${res.mergedMrn} into primary chart ${res.intoMrn}`, 'success');
      setShowMerge(false);
      setMergeReason('');
      loadPatients();
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAssignDoctor(visitId: number) {
    const selectedDocId = assignDoctorSelections[visitId] || (doctors[0] ? String(doctors[0].id) : '');
    if (!selectedDocId) {
      onNotify('Select an active OPD doctor first.', 'error');
      return;
    }
    setAssigningVisitId(visitId);
    try {
      const res = await apiFetch<{ doctor_name: string; specialty: string }>(`/api/visits/${visitId}/assign-doctor`, {
        method: 'PATCH',
        body: JSON.stringify({ doctor_id: Number(selectedDocId) }),
      });
      onNotify(`Assigned visit to ${res.doctor_name} (${res.specialty}) · Notification sent`, 'success');
      loadVisits();
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setAssigningVisitId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Sub-navigation & Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            onClick={() => setSubTab('patients')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'patients' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Patient Registry ({patientTotal})
          </button>
          {canReadVisits && (
            <button
              onClick={() => setSubTab('visits')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                subTab === 'visits' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Patient Visits ({visits.length})
            </button>
          )}
          {canAssignDoctor && (
            <button
              onClick={() => setSubTab('assign_doctor')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                subTab === 'assign_doctor' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              OPD Doctor Assignment
            </button>
          )}
          <button
            onClick={() => setSubTab('queue')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'queue' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Department Queue ({tickets.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canMerge && patients.length >= 2 && (
            <button
              onClick={() => {
                setMergeSourceId(String(patients[patients.length - 1]?.id || ''));
                setMergeTargetId(String(patients[0]?.id || ''));
                setShowMerge(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <GitMerge className="w-3.5 h-3.5" />
              <span>Merge Duplicates</span>
            </button>
          )}
          {canCreateVisit && (
            <button
              onClick={() => openCreateVisitModal()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-300 hover:bg-teal-100 rounded-md transition-colors whitespace-nowrap"
            >
              <Stethoscope className="w-3.5 h-3.5" />
              <span>New Walk-in Visit</span>
            </button>
          )}
          {canCreate && (
            <button
              onClick={() => openCreatePatientFromLookup()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create New Patient</span>
            </button>
          )}
        </div>
      </div>

      {lastCreatedVisit && (
        <div className="p-3.5 bg-teal-50/90 border border-teal-200 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-slate-900">
                Walk-In Visit Created: <span className="font-mono text-teal-800">{lastCreatedVisit.visitNumber}</span> — {lastCreatedVisit.patientName}{' '}
                <span className="font-mono text-slate-500">({lastCreatedVisit.mrn})</span>
              </div>
              <div className="text-slate-700 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  Queue Ticket: <strong className="font-mono">{lastCreatedVisit.ticketNumber}</strong> →{' '}
                  <strong className="font-mono text-teal-800">{lastCreatedVisit.queueDepartment}</strong>
                </span>
                {lastCreatedVisit.consultationInvoiceNumber ? (
                  <span>
                    Consultation Invoice: <strong className="font-mono">{lastCreatedVisit.consultationInvoiceNumber}</strong>{' '}
                    (<span className="font-mono tabular-nums">${lastCreatedVisit.consultationFee.toFixed(2)}</span> ·{' '}
                    <span className="capitalize">{(lastCreatedVisit.consultationInvoiceStatus || 'unpaid').replace('_', ' ')}</span>)
                    {lastCreatedVisit.receiptNumber && (
                      <span> · Receipt <strong className="font-mono text-teal-800">{lastCreatedVisit.receiptNumber}</strong></span>
                    )}
                  </span>
                ) : (
                  <span>No consultation invoice generated (exempt/waived)</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setDeptFilter(lastCreatedVisit.queueDepartment || 'ALL');
                setSubTab('queue');
              }}
              className="px-3 py-1.5 text-xs font-medium text-teal-800 bg-white border border-teal-300 hover:bg-teal-100 rounded-md whitespace-nowrap"
            >
              View in {lastCreatedVisit.queueDepartment} Queue
            </button>
            <button
              onClick={() => setLastCreatedVisit(null)}
              className="p-1 text-slate-400 hover:text-slate-700"
              aria-label="Dismiss visit confirmation"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {subTab === 'patients' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/50 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Patient Lookup</h2>
                <p className="text-xs text-slate-500">
                  Search existing patients by Name, Phone Number, or MRN before billing or visit check-in.
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-md text-xs">
                {(
                  [
                    { key: 'all', label: 'All Fields' },
                    { key: 'name', label: 'Name' },
                    { key: 'phone', label: 'Phone' },
                    { key: 'mrn', label: 'MRN' },
                  ] as const
                ).map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    onClick={() => {
                      setLookupField(mode.key);
                      setPatientPage(1);
                    }}
                    className={`px-2.5 py-1 rounded font-medium transition-colors ${
                      lookupField === mode.key
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative flex-1 min-w-[260px] max-w-xl">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPatientPage(1);
                  }}
                  placeholder={
                    lookupField === 'name'
                      ? 'Lookup by patient first or last name (e.g. Elena Rostova)...'
                      : lookupField === 'phone'
                        ? 'Lookup by phone number (e.g. +1-555-0101 or 5550101)...'
                        : lookupField === 'mrn'
                          ? 'Lookup by MRN / Patient ID (e.g. C360-000100)...'
                          : 'Lookup by Name, Phone Number, or MRN...'
                  }
                  className="w-full pl-9 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setDebouncedSearch('');
                      setPatientPage(1);
                    }}
                    aria-label="Clear patient lookup"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                {clinicalMasked && <span>Clinical fields masked</span>}
                <span className="font-mono">
                  {debouncedSearch ? `${patientTotal} match${patientTotal === 1 ? '' : 'es'}` : `Page ${patientPage} · ${patientTotal} total`}
                </span>
                <button
                  disabled={patientPage <= 1}
                  onClick={() => setPatientPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 bg-white border border-slate-200 rounded disabled:opacity-40 hover:bg-slate-50"
                >
                  Prev
                </button>
                <button
                  disabled={patientPage * 25 >= patientTotal}
                  onClick={() => setPatientPage((p) => p + 1)}
                  className="px-2.5 py-1 bg-white border border-slate-200 rounded disabled:opacity-40 hover:bg-slate-50"
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Searching patient records...</div>
          ) : patients.length === 0 ? (
            <div className="p-10 text-center max-w-lg mx-auto space-y-3">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-slate-100 text-slate-500">
                <Search className="w-5 h-5" />
              </div>
              <div className="text-sm font-semibold text-slate-900">
                {debouncedSearch
                  ? `No patient record found for "${debouncedSearch}"`
                  : 'No patient records found'}
              </div>
              <p className="text-xs text-slate-500">
                {debouncedSearch
                  ? `Searched by ${
                      lookupField === 'all'
                        ? 'Name, Phone, and MRN'
                        : lookupField === 'mrn'
                          ? 'MRN'
                          : lookupField === 'phone'
                            ? 'Phone Number'
                            : 'Patient Name'
                    }. Verify the details or create a new patient chart to generate an MRN.`
                  : 'Register a new patient to create an Electronic Medical Record (EMR) and issue an MRN.'}
              </p>
              <div className="pt-1 flex flex-wrap items-center justify-center gap-2.5">
                {canCreate && (
                  <button
                    type="button"
                    onClick={() => openCreatePatientFromLookup(debouncedSearch)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>Create New Patient</span>
                  </button>
                )}
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setDebouncedSearch('');
                      setLookupField('all');
                      setPatientPage(1);
                    }}
                    className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md"
                  >
                    Clear Search
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">MRN</th>
                    <th className="py-2.5 px-4">Patient Name</th>
                    <th className="py-2.5 px-4">Demographics</th>
                    <th className="py-2.5 px-4">Phone</th>
                    <th className="py-2.5 px-4">Payer Type</th>
                    {!clinicalMasked && <th className="py-2.5 px-4">Allergies / Blood</th>}
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {patients.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/80">
                      <td className="py-2.5 px-4 font-mono text-xs font-medium text-teal-800 tabular-nums whitespace-nowrap">
                        {p.mrn}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900 whitespace-nowrap">
                        {p.first_name} {p.last_name}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-600 whitespace-nowrap">
                        <span>{p.sex}</span>
                        <span className="mx-1.5 text-slate-300">·</span>
                        <span className="font-mono tabular-nums">{p.date_of_birth}</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                        {p.phone}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-700 whitespace-nowrap">
                        <span className="capitalize font-medium">{p.patient_type}</span>
                        {p.payer_name && <span className="text-slate-500"> · {p.payer_name}</span>}
                      </td>
                      {!clinicalMasked && (
                        <td className="py-2.5 px-4 text-xs">
                          <span className={p.allergies && p.allergies !== 'None known' ? 'text-red-700 font-medium' : 'text-slate-500'}>
                            {p.allergies || 'None known'}
                          </span>
                          {p.blood_group && (
                            <span className="text-slate-400 font-mono"> · {p.blood_group}</span>
                          )}
                        </td>
                      )}
                      <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-2">
                        <button
                          onClick={() => openPatientDetail(p.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-teal-800 border border-slate-200 hover:border-teal-600 rounded"
                        >
                          <Eye className="w-3 h-3" />
                          <span>360° Record</span>
                        </button>
                        {canUpdatePatient && (
                          <button
                            onClick={() => openEditPatient(p)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 border border-slate-200 hover:border-slate-400 rounded"
                          >
                            <Edit2 className="w-3 h-3" />
                            <span>Edit</span>
                          </button>
                        )}
                        {canCreateVisit && (
                          <button
                            onClick={() => openCreateVisitModal(p)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                          >
                            <Stethoscope className="w-3 h-3" />
                            <span>New Walk-in Visit</span>
                          </button>
                        )}
                        {canQueue && (
                          <button
                            onClick={() => issueQuickTicket(p.id, 'OPD')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 border border-teal-200 rounded"
                          >
                            <Plus className="w-3 h-3" />
                            <span>Queue</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'queue' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md">
              {['ALL', 'CSH', 'TRIAGE', 'OPD', 'LAB', 'PHA'].map((d) => (
                <button
                  key={d}
                  onClick={() => setDeptFilter(d)}
                  className={`px-3 py-1 text-xs font-medium rounded ${
                    deptFilter === d ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {canQueue && deptFilter !== 'ALL' && (
                <button
                  onClick={handleCallNextInDept}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                >
                  <Megaphone className="w-3.5 h-3.5" />
                  <span>Call Next Waiting ({deptFilter})</span>
                </button>
              )}
              <div className="text-xs text-slate-500">Ordered by triage priority (Emergency &gt; Urgent &gt; Routine)</div>
            </div>
          </div>

          {tickets.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No active tickets in this department queue.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Ticket</th>
                    <th className="py-2.5 px-4">Department &amp; Stage</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Priority</th>
                    <th className="py-2.5 px-4">Status</th>
                    {canQueue && <th className="py-2.5 px-4 text-right">Queue Controls</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {tickets.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                        <div>{t.ticket_number}</div>
                        {t.visit_number && (
                          <div className="text-[11px] font-normal text-slate-500">{t.visit_number}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-xs">
                        <div className="font-mono font-semibold text-slate-700">{t.department}</div>
                        {t.notes && <div className="text-[11px] text-teal-800">{t.notes}</div>}
                        {t.consultation_invoice_number && (
                          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                            {t.consultation_invoice_number} ({(t.consultation_invoice_status || 'unpaid').replace('_', ' ')})
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">{t.first_name} {t.last_name}</div>
                        <div className="text-xs font-mono text-slate-500">
                          {t.mrn}
                          {t.doctor_name ? ` · ${t.doctor_name}` : ''}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-xs">
                        <span className={t.priority === 'emergency' ? 'text-red-700 font-semibold' : t.priority === 'urgent' ? 'text-amber-700 font-medium' : 'text-slate-600'}>
                          {t.priority}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-700 capitalize">
                        {t.status.replace('_', ' ')}
                      </td>
                      {canQueue && (
                        <td className="py-2.5 px-4 text-right space-x-1.5 whitespace-nowrap">
                          {t.department === 'CSH' &&
                            t.consultation_invoice_id &&
                            t.consultation_invoice_status === 'unpaid' &&
                            canCollectPayment && (
                              <button
                                onClick={() => handleQuickCollectAndTriage(t)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                              >
                                <CreditCard className="w-3 h-3" />
                                <span>Collect &amp; Send to Triage</span>
                              </button>
                            )}
                          {t.status === 'waiting' && (
                            <button
                              onClick={() => updateTicketStatus(t.id, 'called')}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              Call Next
                            </button>
                          )}
                          {t.status === 'called' && (
                            <button
                              onClick={() => updateTicketStatus(t.id, 'in_service')}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded"
                            >
                              Start Service
                            </button>
                          )}
                          <button
                            onClick={() => updateTicketStatus(t.id, 'completed')}
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                          >
                            Complete
                          </button>
                          {t.priority !== 'emergency' && (
                            <button
                              onClick={() => updateTicketStatus(t.id, undefined, 'urgent')}
                              className="px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 rounded"
                            >
                              Prioritize
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {(subTab === 'visits' || subTab === 'assign_doctor') && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {subTab === 'assign_doctor' ? 'OPD Doctor Assignment' : 'Patient Visits & Triage Status'}
              </h2>
              <p className="text-xs text-slate-500">
                {subTab === 'assign_doctor'
                  ? 'Assign registered & vitals-checked patients to an OPD doctor. Assigning sends a targeted alert to that doctor only.'
                  : 'Track active walk-in and scheduled visits across payment, vital signs, doctor assignment, and completion.'}
              </p>
            </div>
            {canCreateVisit && (
              <button
                onClick={() => openCreateVisitModal()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Register New Visit</span>
              </button>
            )}
          </div>
          {visitsLoading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading visits...</div>
          ) : visits.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No visits available for your current scope.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Visit #</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Stage &amp; Payment</th>
                    <th className="py-2.5 px-4">Vitals</th>
                    <th className="py-2.5 px-4">Assigned Doctor</th>
                    {canAssignDoctor && <th className="py-2.5 px-4 text-right">Assign OPD Doctor</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {visits.map((v) => {
                    const isClosed = v.status === 'closed';
                    const selectedDoc =
                      assignDoctorSelections[v.id] ?? (v.doctor_id ? String(v.doctor_id) : doctors[0] ? String(doctors[0].id) : '');
                    return (
                      <tr key={v.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono">
                          <div className="font-semibold text-slate-900">{v.visit_number}</div>
                          <div className="text-[11px] text-slate-500 capitalize">
                            {(v.visit_type || 'walk_in').replace('_', ' ')} · {v.triage_priority}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{v.first_name} {v.last_name}</div>
                          <div className="font-mono text-slate-500">{v.mrn}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-800 capitalize">
                            {(v.workflow_stage || v.status).replace(/_/g, ' ')}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {v.consultation_invoice_number
                              ? `${v.consultation_invoice_number} (${(v.consultation_invoice_status || 'unpaid').replace('_', ' ')})`
                              : v.patient_type}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums">
                          {(v.vitals_count ?? 0) > 0 ? (
                            <span className="text-emerald-700 font-semibold">{v.vitals_count} recorded</span>
                          ) : (
                            <span className="text-amber-700">Pending vitals</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {v.doctor_name ? (
                            <div>
                              <div className="font-medium text-slate-900">{v.doctor_name}</div>
                              <div className="text-[11px] text-slate-500">{v.specialty || 'OPD'}</div>
                            </div>
                          ) : (
                            <span className="text-amber-700 font-medium">Unassigned</span>
                          )}
                        </td>
                        {canAssignDoctor && (
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {isClosed ? (
                              <span className="text-slate-400">Closed</span>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <select
                                  value={selectedDoc}
                                  onChange={(e) =>
                                    setAssignDoctorSelections((prev) => ({ ...prev, [v.id]: e.target.value }))
                                  }
                                  className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                                >
                                  {doctors.map((d) => (
                                    <option key={d.id} value={d.id}>
                                      {d.full_name} {d.specialty ? `(${d.specialty})` : ''}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={assigningVisitId === v.id || !selectedDoc}
                                  onClick={() => handleAssignDoctor(v.id)}
                                  className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded disabled:opacity-50"
                                >
                                  {assigningVisitId === v.id ? 'Saving...' : v.doctor_id ? 'Reassign' : 'Assign Doctor'}
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Register Patient Modal */}
      {showRegister && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">New Patient Registration</h3>
              <button onClick={() => setShowRegister(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreatePatient} className="p-6 space-y-4">
              {duplicates.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Potential Duplicate Patient Found</div>
                    {duplicates.map((d) => (
                      <div key={d.id} className="mt-0.5 font-mono">
                        {d.mrn} — {d.first_name} {d.last_name} ({d.phone})
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">First Name *</label>
                  <input
                    required
                    value={form.first_name}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Last Name *</label>
                  <input
                    required
                    value={form.last_name}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Sex *</label>
                  <select
                    value={form.sex}
                    onChange={(e) => setForm({ ...form, sex: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="Female">Female</option>
                    <option value="Male">Male</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-700">Date of Birth *</label>
                    <label className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={form.dob_estimated}
                        onChange={(e) => setForm({ ...form, dob_estimated: e.target.checked })}
                      />
                      <span>Estimated DOB</span>
                    </label>
                  </div>
                  <input
                    type="date"
                    required
                    value={form.date_of_birth}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Phone *</label>
                  <input
                    required
                    value={form.phone}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+1-555-0190"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Patient Payer Type</label>
                  <select
                    value={form.patient_type}
                    onChange={(e) => setForm({ ...form, patient_type: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="self-pay">Self-Pay</option>
                    <option value="insurance">Insurance</option>
                    <option value="credit">Credit (Company / NGO)</option>
                    <option value="exempt">Exempt (Staff / Free Care)</option>
                  </select>
                </div>
                {(form.patient_type === 'insurance' || form.patient_type === 'credit') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Insurer / Payer Name</label>
                      <input
                        value={form.payer_name}
                        onChange={(e) => setForm({ ...form, payer_name: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Policy / Member Number</label>
                      <input
                        value={form.insurance_number}
                        onChange={(e) => setForm({ ...form, insurance_number: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Blood Group</label>
                  <select
                    value={form.blood_group}
                    onChange={(e) => setForm({ ...form, blood_group: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    {['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'Unknown'].map((bg) => (
                      <option key={bg} value={bg}>{bg}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Known Allergies</label>
                  <input
                    value={form.allergies}
                    onChange={(e) => setForm({ ...form, allergies: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact Name</label>
                  <input
                    value={form.next_of_kin_name}
                    onChange={(e) => setForm({ ...form, next_of_kin_name: e.target.value })}
                    placeholder="Next of kin / guardian"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact Phone</label>
                  <input
                    value={form.next_of_kin_phone}
                    onChange={(e) => setForm({ ...form, next_of_kin_phone: e.target.value })}
                    placeholder="+1-555-0191"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Residential Address</label>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
              </div>

              <div className="pt-2 flex flex-wrap gap-5 text-xs text-slate-700">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.issue_queue_ticket}
                    disabled={openVisitAfterRegister}
                    onChange={(e) => setForm({ ...form, issue_queue_ticket: e.target.checked })}
                  />
                  <span>Issue standalone OPD queue ticket immediately</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.charge_registration_card}
                    onChange={(e) => setForm({ ...form, charge_registration_card: e.target.checked })}
                  />
                  <span>Generate $15.00 registration card invoice</span>
                </label>
                {canCreateVisit && (
                  <label className="inline-flex items-center gap-2 font-medium text-teal-800">
                    <input
                      type="checkbox"
                      checked={openVisitAfterRegister}
                      onChange={(e) => setOpenVisitAfterRegister(e.target.checked)}
                    />
                    <span>Open Create Visit (Walk-In + Consultation Invoice) right after saving</span>
                  </label>
                )}
              </div>

              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  {openVisitAfterRegister ? 'Save Patient & New Walk-in Visit' : 'Save Patient & Generate MRN'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Patient 360 Record Modal */}
      {selectedDetail && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {selectedDetail.patient.first_name} {selectedDetail.patient.last_name}
                </h3>
                <div className="text-xs text-slate-500 font-mono mt-0.5">
                  {selectedDetail.patient.mrn} · {selectedDetail.patient.sex} · DOB {selectedDetail.patient.date_of_birth} · {selectedDetail.patient.phone}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canCreateVisit && (
                  <button
                    onClick={() => {
                      const p = selectedDetail.patient;
                      setSelectedDetail(null);
                      openCreateVisitModal(p);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                  >
                    <Stethoscope className="w-3.5 h-3.5" />
                    <span>New Walk-in Visit</span>
                  </button>
                )}
                <button onClick={() => setSelectedDetail(null)} className="text-slate-400 hover:text-slate-700">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {breakGlassCleared[selectedDetail.patient.id] && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex items-start gap-2">
                  <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <strong>Break-Glass Override Active:</strong> {breakGlassCleared[selectedDetail.patient.id]}
                  </div>
                </div>
              )}

              {/* Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-5 border-b border-slate-200 text-xs">
                <div>
                  <div className="text-slate-500">Payer Category</div>
                  <div className="mt-1 font-medium text-slate-900 capitalize">
                    {selectedDetail.patient.patient_type}
                    {selectedDetail.patient.payer_name ? ` (${selectedDetail.patient.payer_name})` : ''}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Blood Group</div>
                  <div className="mt-1 font-mono font-medium text-slate-900">
                    {selectedDetail.patient.blood_group || 'Not recorded'}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-slate-500">Recorded Allergies</div>
                  <div className={`mt-1 font-medium ${selectedDetail.patient.allergies && !selectedDetail.clinicalMasked && selectedDetail.patient.allergies !== 'None known' ? 'text-red-700' : 'text-slate-900'}`}>
                    {selectedDetail.patient.allergies || 'None known'}
                  </div>
                </div>
              </div>

              {selectedDetail.clinicalMasked ? (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-600">
                  Clinical encounters, vitals, and diagnostic notes are hidden because your assigned role does not hold clinical read permissions.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-900 mb-2.5">OPD Visits &amp; Diagnoses</h4>
                    {selectedDetail.visits.length === 0 ? (
                      <div className="text-xs text-slate-500">No recorded visits yet.</div>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                        {selectedDetail.visits.map((v) => (
                          <div key={v.id} className="p-3 text-xs">
                            <div className="flex justify-between font-mono text-slate-500">
                              <span>{v.visit_number}</span>
                              <span>{v.status}</span>
                            </div>
                            <div className="font-medium text-slate-900 mt-1">
                              {v.diagnosis_text || 'Diagnosis pending'}
                            </div>
                            <div className="text-slate-500 mt-0.5">{v.doctor_name || 'Unassigned'}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold text-slate-900 mb-2.5">Recent Vitals</h4>
                    {selectedDetail.vitals.length === 0 ? (
                      <div className="text-xs text-slate-500">No vitals recorded.</div>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                        {selectedDetail.vitals.map((vt) => (
                          <div key={vt.id} className="p-3 text-xs font-mono tabular-nums">
                            <div className="text-slate-900">
                              BP {vt.bp_systolic ?? '-'}/{vt.bp_diastolic ?? '-'} · Temp {vt.temperature ?? '-'}°C · SpO2 {vt.spo2 ?? '-'}%
                            </div>
                            <div className="text-slate-500 mt-0.5">{vt.recorded_at}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedDetail.invoices.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 mb-2.5">Patient Billing Ledger</h4>
                  <div className="border border-slate-200 rounded-md overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                        <tr>
                          <th className="py-2 px-3">Invoice</th>
                          <th className="py-2 px-3 text-right">Total</th>
                          <th className="py-2 px-3 text-right">Paid</th>
                          <th className="py-2 px-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedDetail.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td className="py-2 px-3 font-mono">{inv.invoice_number}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(inv.total_amount).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(inv.paid_amount).toFixed(2)}</td>
                            <td className="py-2 px-3 capitalize">{inv.status.replace('_', ' ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {selectedDetail.accessHistory.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 mb-2 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-700" />
                    <span>Record Access Audit Trail (Who Viewed This Patient)</span>
                  </h4>
                  <div className="border border-slate-200 rounded-md divide-y divide-slate-100 text-xs">
                    {selectedDetail.accessHistory.slice(0, 6).map((h) => (
                      <div key={h.id} className="px-3 py-2 flex items-center justify-between text-slate-600">
                        <span>
                          <strong className="text-slate-900">{h.user_name}</strong> ({h.role_at_time}) — <span className="font-mono">{h.action}</span>
                        </span>
                        <span className="font-mono text-slate-400 tabular-nums">{h.occurred_at}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Merge Duplicate Patients Modal */}
      {showMerge && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Merge Duplicate Patient Charts</h3>
              <button onClick={() => setShowMerge(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleMergePatients} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Duplicate Chart (Source — will be archived) *</label>
                <select
                  required
                  value={mergeSourceId}
                  onChange={(e) => setMergeSourceId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name} ({p.phone})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Primary Chart (Target — receives all history) *</label>
                <select
                  required
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name} ({p.phone})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Audit Reason *</label>
                <textarea
                  required
                  rows={2}
                  value={mergeReason}
                  onChange={(e) => setMergeReason(e.target.value)}
                  placeholder="Confirm identity verification across both MRNs"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowMerge(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md">
                  Execute Audited Merge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Break-Glass Clinical Override Modal */}
      {breakGlassPending && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                <Lock className="w-4 h-4 text-amber-700" />
                <span>Break-Glass Chart Access</span>
              </h3>
              <button onClick={() => setBreakGlassPending(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleConfirmBreakGlass} className="p-6 space-y-4">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                <strong>Cross-Patient Access Notice:</strong> You are not currently listed as the active attending doctor for{' '}
                <strong>
                  {breakGlassPending.patient.first_name} {breakGlassPending.patient.last_name}
                </strong>{' '}
                (<span className="font-mono">{breakGlassPending.patient.mrn}</span>). Opening this clinical record triggers a high-priority audit alert to the Auditor &amp; Medical Director.
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Mandatory Clinical Justification (min 8 chars) *
                </label>
                <textarea
                  required
                  minLength={8}
                  rows={3}
                  value={breakGlassReason}
                  onChange={(e) => setBreakGlassReason(e.target.value)}
                  placeholder="e.g. Covering emergency night call / urgent cross-specialty consult..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBreakGlassPending(null)}
                  className="px-4 py-2 text-xs border border-slate-300 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-md"
                >
                  Log Override &amp; Open Chart
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Patient Demographics Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Edit Patient · {editTarget.mrn}
              </h3>
              <button onClick={() => setEditTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleUpdatePatient} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">First Name *</label>
                  <input
                    required
                    value={editForm.first_name}
                    onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Last Name *</label>
                  <input
                    required
                    value={editForm.last_name}
                    onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Sex *</label>
                  <select
                    value={editForm.sex}
                    onChange={(e) => setEditForm({ ...editForm, sex: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="Female">Female</option>
                    <option value="Male">Male</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date of Birth *</label>
                  <input
                    type="date"
                    required
                    value={editForm.date_of_birth}
                    onChange={(e) => setEditForm({ ...editForm, date_of_birth: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Phone *</label>
                  <input
                    required
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Patient Payer Type</label>
                  <select
                    value={editForm.patient_type}
                    onChange={(e) => setEditForm({ ...editForm, patient_type: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="self-pay">Self-Pay</option>
                    <option value="insurance">Insurance</option>
                    <option value="credit">Credit (Company / NGO)</option>
                    <option value="exempt">Exempt</option>
                  </select>
                </div>
                {(editForm.patient_type === 'insurance' || editForm.patient_type === 'credit') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Insurer / Payer Name</label>
                      <input
                        value={editForm.payer_name}
                        onChange={(e) => setEditForm({ ...editForm, payer_name: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                      />
                    </div>
                    {canClinicalRead && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Policy / Member Number</label>
                        <input
                          value={editForm.insurance_number}
                          onChange={(e) => setEditForm({ ...editForm, insurance_number: e.target.value })}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                        />
                      </div>
                    )}
                  </>
                )}
                {canClinicalRead && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Blood Group</label>
                      <select
                        value={editForm.blood_group}
                        onChange={(e) => setEditForm({ ...editForm, blood_group: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                      >
                        {['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'Unknown'].map((bg) => (
                          <option key={bg} value={bg}>{bg}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Known Allergies</label>
                      <input
                        value={editForm.allergies}
                        onChange={(e) => setEditForm({ ...editForm, allergies: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact Name</label>
                  <input
                    value={editForm.next_of_kin_name}
                    onChange={(e) => setEditForm({ ...editForm, next_of_kin_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact Phone</label>
                  <input
                    value={editForm.next_of_kin_phone}
                    onChange={(e) => setEditForm({ ...editForm, next_of_kin_phone: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Residential Address</label>
                  <input
                    value={editForm.address}
                    onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                {editIdentityChanged && (
                  <div className="sm:col-span-2 p-3 bg-amber-50 border border-amber-200 rounded-md">
                    <label className="block text-xs font-semibold text-amber-900 mb-1">
                      Mandatory Identity Change Audit Reason (min 5 chars) *
                    </label>
                    <input
                      required
                      minLength={5}
                      value={editForm.identity_change_reason}
                      onChange={(e) => setEditForm({ ...editForm, identity_change_reason: e.target.value })}
                      placeholder="e.g. Corrected legal spelling per national ID verification"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-amber-300 rounded-md"
                    />
                  </div>
                )}
                {editPayerChanged && (
                  <div className="sm:col-span-2 p-3 bg-amber-50 border border-amber-200 rounded-md">
                    <label className="block text-xs font-semibold text-amber-900 mb-1">
                      Mandatory Payer Category Change Reason (min 5 chars) *
                    </label>
                    <input
                      required
                      minLength={5}
                      value={editForm.payer_change_reason}
                      onChange={(e) => setEditForm({ ...editForm, payer_change_reason: e.target.value })}
                      placeholder="e.g. Updated corporate insurance policy card"
                      className="w-full px-3 py-1.5 text-xs bg-white border border-amber-300 rounded-md"
                    />
                  </div>
                )}
              </div>
              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditTarget(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Save Patient Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Walk-In Visit & Consultation Invoice Modal */}
      {showCreateVisit && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                  <Stethoscope className="w-4 h-4 text-teal-700" />
                  <span>New Walk-in Visit</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Create a visit for the selected patient, assign the department queue, and generate the initial consultation invoice for Cash-Before-Service clearance.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowCreateVisit(false);
                  setVisitPatient(null);
                }}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleStartVisit} className="p-6 space-y-4">
              {/* Patient Selector / Summary */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-700">Patient *</label>
                  {visitPatient && (
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 capitalize">
                      {visitPatient.patient_type}
                      {visitPatient.payer_name ? ` · ${visitPatient.payer_name}` : ''}
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={visitPatientSearch}
                  onChange={(e) => setVisitPatientSearch(e.target.value)}
                  placeholder="Filter patient list by MRN, name, or phone..."
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
                />
                <select
                  required
                  value={visitPatient ? String(visitPatient.id) : ''}
                  onChange={(e) => {
                    const found = patients.find((p) => p.id === Number(e.target.value)) || null;
                    setVisitPatient(found);
                    if (found) {
                      setVisitForm((prev) => ({
                        ...prev,
                        generate_consultation_invoice: found.patient_type !== 'exempt',
                      }));
                    }
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="">Select patient...</option>
                  {filteredVisitPatients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name} ({p.phone} · {p.patient_type})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Visit Type *</label>
                  <select
                    value={visitForm.visit_type}
                    onChange={(e) => {
                      const nextType = e.target.value;
                      setVisitForm((prev) => ({
                        ...prev,
                        visit_type: nextType,
                        service_code: defaultServiceCodeFor(prev.specialty, nextType),
                      }));
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="walk_in">Walk-In Consultation</option>
                    <option value="follow_up">Follow-Up Review</option>
                    <option value="scheduled">Scheduled Appointment</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Triage Priority *</label>
                  <select
                    value={visitForm.triage_priority}
                    onChange={(e) => setVisitForm({ ...visitForm, triage_priority: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                    <option value="emergency">Emergency (Immediate Triage)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Medical Specialty *</label>
                  <select
                    value={visitForm.specialty}
                    onChange={(e) => {
                      const nextSpec = e.target.value;
                      const matchedDoc = doctors.find((d) =>
                        (d.specialty || '').toLowerCase().includes(nextSpec.split(' ')[0].toLowerCase())
                      );
                      setVisitForm((prev) => ({
                        ...prev,
                        specialty: nextSpec,
                        service_code: defaultServiceCodeFor(nextSpec, prev.visit_type),
                        doctor_id: matchedDoc ? String(matchedDoc.id) : prev.doctor_id,
                      }));
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="General Medicine">General Medicine</option>
                    <option value="Pediatrics">Pediatrics</option>
                    <option value="Gynecology">Gynecology</option>
                    <option value="Dermatology">Dermatology</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Assigned Clinician</label>
                  <select
                    value={visitForm.doctor_id}
                    onChange={(e) => {
                      const nextDocId = e.target.value;
                      const doc = doctors.find((d) => String(d.id) === nextDocId);
                      setVisitForm((prev) => {
                        const nextSpec = doc?.specialty || prev.specialty;
                        return {
                          ...prev,
                          doctor_id: nextDocId,
                          specialty: nextSpec,
                          service_code: defaultServiceCodeFor(nextSpec, prev.visit_type),
                        };
                      });
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">Any Available Doctor</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.full_name}
                        {d.specialty ? ` (${d.specialty})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Consultation Tariff / Service Item</label>
                  <select
                    value={visitForm.service_code}
                    onChange={(e) => setVisitForm({ ...visitForm, service_code: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    {consultServices.length > 0 ? (
                      consultServices.map((svc) => (
                        <option key={svc.code} value={svc.code}>
                          {svc.code} — {svc.name} (${Number(svc.unit_price).toFixed(2)})
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="CON-GEN">CON-GEN — General Medicine Consultation ($45.00)</option>
                        <option value="CON-PED">CON-PED — Pediatrics Consultation ($55.00)</option>
                        <option value="CON-GYN">CON-GYN — Gynecology Consultation ($65.00)</option>
                        <option value="CON-DERM">CON-DERM — Dermatology Consultation ($60.00)</option>
                        <option value="OPD-FU">OPD-FU — Follow-up Consultation ($25.00)</option>
                      </>
                    )}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Chief Complaint / Reason for Visit</label>
                  <input
                    type="text"
                    value={visitForm.chief_complaint}
                    onChange={(e) => setVisitForm({ ...visitForm, chief_complaint: e.target.value })}
                    placeholder="e.g. Fever and persistent cough x 3 days"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
              </div>

              {/* Billing & Queue Assignment Preview */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2.5 text-xs">
                <label className="inline-flex items-center gap-2 font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={visitPatient?.patient_type === 'exempt' ? false : visitForm.visit_type === 'walk_in' ? true : visitForm.generate_consultation_invoice}
                    disabled={visitPatient?.patient_type === 'exempt' || visitForm.visit_type === 'walk_in'}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, generate_consultation_invoice: e.target.checked })
                    }
                  />
                  <Receipt className="w-3.5 h-3.5 text-teal-700" />
                  <span>
                    Generate initial consultation invoice
                    {visitPatient?.patient_type === 'exempt'
                      ? ' (Exempt patient — no charge)'
                      : selectedConsultService
                        ? ` ($${Number(selectedConsultService.unit_price).toFixed(2)} · Cash-Before-Service)`
                        : ' (Cash-Before-Service)'}
                  </span>
                </label>

                {canCollectPayment && visitPatient?.patient_type === 'self-pay' && willGenerateConsultInvoice && (
                  <div className="p-3 bg-white border border-slate-200 rounded-md space-y-2.5">
                    {!hasOpenShift ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-amber-800 font-medium">
                          Open a Cashier Shift to collect payment now and add directly to TRIAGE queue.
                        </span>
                        {canManageShift && (
                          <button
                            type="button"
                            disabled={openingShiftInline}
                            onClick={handleOpenQuickShift}
                            className="px-3 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded disabled:opacity-50"
                          >
                            {openingShiftInline ? 'Opening...' : 'Open Shift ($200.00)'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <label className="inline-flex items-center gap-2 font-medium text-teal-900">
                          <input
                            type="checkbox"
                            checked={collectPaymentNow}
                            onChange={(e) => setCollectPaymentNow(e.target.checked)}
                          />
                          <CreditCard className="w-3.5 h-3.5 text-teal-700" />
                          <span>Collect consultation payment now &amp; add directly to TRIAGE queue</span>
                        </label>
                        {collectPaymentNow && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                            <div>
                              <label className="block text-[11px] font-medium text-slate-600 mb-1">Payment Method</label>
                              <select
                                value={paymentMethod}
                                onChange={(e) =>
                                  setPaymentMethod(e.target.value as 'cash' | 'card' | 'mobile_money' | 'bank_transfer')
                                }
                                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                              >
                                <option value="cash">Cash</option>
                                <option value="card">Card / POS</option>
                                <option value="mobile_money">Mobile Money</option>
                                <option value="bank_transfer">Bank Transfer</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-slate-600 mb-1">Reference (optional)</label>
                              <input
                                type="text"
                                value={paymentReference}
                                onChange={(e) => setPaymentReference(e.target.value)}
                                placeholder="POS / Txn ref"
                                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded font-mono"
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {visitWillAwaitPayment ? (
                  <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-amber-900">
                    <strong>Queue Assignment: CSH (Cashier Payment Gate)</strong> — Self-pay walk-in patient will be queued at{' '}
                    <span className="font-mono font-semibold">CSH</span> to clear consultation payment first, then automatically advance to{' '}
                    <span className="font-mono font-semibold">TRIAGE</span> (Vital Room).
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-slate-700">Assigned Queue Department:</span>
                      <select
                        value={visitForm.queue_department}
                        onChange={(e) => setVisitForm({ ...visitForm, queue_department: e.target.value })}
                        className="px-2.5 py-1 text-xs border border-slate-300 rounded bg-white font-medium"
                      >
                        <option value="TRIAGE">TRIAGE — Vital Room (Triage Queue)</option>
                        <option value="OPD">OPD — Outpatient Desk</option>
                      </select>
                    </div>
                    <div className="p-2.5 bg-teal-50 border border-teal-200 rounded text-teal-900">
                      Ticket number will be generated automatically and added to{' '}
                      <span className="font-mono font-semibold">{visitForm.queue_department}</span> (
                      {cashierPayingUpfront
                        ? 'Payment collected at Cashier check-in'
                        : visitForm.triage_priority === 'emergency'
                          ? 'Emergency Priority'
                          : visitPatient?.patient_type === 'insurance' || visitPatient?.patient_type === 'credit'
                            ? `${visitPatient.patient_type} credit-billed`
                            : 'Exempt / No upfront charge'}
                      ).
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateVisit(false);
                    setVisitPatient(null);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingVisit || !visitPatient}
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md"
                >
                  {submittingVisit
                    ? 'Creating Walk-in Visit...'
                    : cashierPayingUpfront
                      ? 'Collect Fee, Issue Ticket & Add to Triage'
                      : 'Create Walk-in Visit & Invoice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
