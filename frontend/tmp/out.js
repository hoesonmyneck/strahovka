import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import { useAuth } from "../context/AuthContext.jsx";
import api from "../utils/api.js";
import { toast } from "react-toastify";
import DatePicker from "react-datepicker";
import {
  LogOut,
  Download,
  Upload,
  Search,
  Filter,
  Users,
  Shield,
  ShieldOff,
  ScrollText,
  FolderOpen,
  Trash2,
  Settings,
  Coins,
  X
} from "lucide-react";
import "react-datepicker/dist/react-datepicker.css";
import OppvSection from "./OppvSection.jsx";
const MONTHS_RU_PREP = [
  "\u044F\u043D\u0432\u0430\u0440\u0435",
  "\u0444\u0435\u0432\u0440\u0430\u043B\u0435",
  "\u043C\u0430\u0440\u0442\u0435",
  "\u0430\u043F\u0440\u0435\u043B\u0435",
  "\u043C\u0430\u0435",
  "\u0438\u044E\u043D\u0435",
  "\u0438\u044E\u043B\u0435",
  "\u0430\u0432\u0433\u0443\u0441\u0442\u0435",
  "\u0441\u0435\u043D\u0442\u044F\u0431\u0440\u0435",
  "\u043E\u043A\u0442\u044F\u0431\u0440\u0435",
  "\u043D\u043E\u044F\u0431\u0440\u0435",
  "\u0434\u0435\u043A\u0430\u0431\u0440\u0435"
];
const getMonthOption = (offset) => {
  const now = /* @__PURE__ */ new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + offset;
  const absYear = y + Math.floor(m / 12);
  const absMon = (m % 12 + 12) % 12;
  const from = new Date(absYear, absMon, 1);
  const to = new Date(absYear, absMon + 1, 0);
  const fmt = (d) => d.toISOString().split("T")[0];
  return {
    label: `\u0418\u0441\u0442\u0435\u043A\u0430\u0435\u0442 \u0432 ${MONTHS_RU_PREP[absMon]}`,
    value: fmt(from),
    // храним как "YYYY-MM-01"
    date_end_from: fmt(from),
    date_end_to: fmt(to)
  };
};
const fmtNumber = (v, decimals = 0) => {
  if (v == null || v === "") return "";
  return Number(v).toLocaleString("ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};
const SuggestInput = ({ field, value, onChange, placeholder }) => {
  const [inputValue, setInputValue] = useState(value);
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    if (value === "") setInputValue("");
  }, [value]);
  const handleChange = (e) => {
    const v = e.target.value;
    setInputValue(v);
    onChange(v);
    clearTimeout(timer.current);
    if (v.length >= 1) {
      timer.current = setTimeout(async () => {
        try {
          const res = await api.get("/api/suggestions", { params: { field, query: v, limit: 10 } });
          setSuggestions(res.data);
          setOpen(res.data.length > 0);
        } catch {
          setSuggestions([]);
        }
      }, 300);
    } else {
      setSuggestions([]);
      setOpen(false);
    }
  };
  const selectSuggestion = (s) => {
    setInputValue(s);
    onChange(s);
    setOpen(false);
  };
  return /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      value: inputValue,
      onChange: handleChange,
      placeholder,
      onBlur: () => setTimeout(() => setOpen(false), 150),
      onFocus: () => suggestions.length > 0 && setOpen(true),
      autoComplete: "off"
    }
  ), open && suggestions.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "suggestions-dropdown" }, suggestions.map((s, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "suggestion-item", onMouseDown: () => selectSuggestion(s) }, s))));
};
const binFormatter = (params) => {
  if (params.value == null || params.value === "") return "";
  return String(params.value).padStart(12, "0");
};
const FileDropzone = ({ onFile, uploading, disabled, accept, label, className = "" }) => {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef();
  const busy = uploading || disabled;
  const pick = (file) => {
    if (file && !busy) onFile(file);
  };
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: `dropzone${className ? " " + className : ""}${drag ? " dragover" : ""}${busy ? " disabled" : ""}`,
      onClick: () => !busy && inputRef.current?.click(),
      onDragOver: (e) => {
        e.preventDefault();
        if (!busy) setDrag(true);
      },
      onDragLeave: () => setDrag(false),
      onDrop: (e) => {
        e.preventDefault();
        setDrag(false);
        pick(e.dataTransfer.files[0]);
      }
    },
    /* @__PURE__ */ React.createElement(Upload, { size: 22 }),
    /* @__PURE__ */ React.createElement("span", { className: "dropzone-label" }, uploading ? "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430..." : label),
    /* @__PURE__ */ React.createElement("span", { className: "dropzone-hint" }, "\u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u0442\u0430\u0449\u0438\u0442\u0435 \u0444\u0430\u0439\u043B \u0441\u044E\u0434\u0430"),
    /* @__PURE__ */ React.createElement(
      "input",
      {
        ref: inputRef,
        type: "file",
        accept,
        disabled: busy,
        hidden: true,
        onChange: (e) => {
          const f = e.target.files[0];
          e.target.value = "";
          pick(f);
        }
      }
    )
  );
};
const Dashboard = () => {
  const { user, logout, isAdmin } = useAuth();
  const gridRef = useRef();
  const canAppvr = isAdmin() || !!user?.appvr_access;
  const [section, setSection] = useState(() => localStorage.getItem("section") || "insurance");
  useEffect(() => {
    localStorage.setItem("section", section);
  }, [section]);
  useEffect(() => {
    if (user && !canAppvr && section === "oppv") setSection("insurance");
  }, [user, canAppvr, section]);
  const [isOppvUploading, setIsOppvUploading] = useState(false);
  const [metrics, setMetrics] = useState({
    total_bins: 0,
    insured_bins: 0,
    not_insured_bins: 0
  });
  const EMPTY_FILTERS = {
    bin: "",
    bin_name: "",
    system_delimiter_bin: "",
    system_delimiter_bin_name: "",
    contract_number: "",
    contract_date_from: null,
    contract_date_to: null,
    date_end_from: null,
    date_end_to: null,
    obl_name: "",
    rai_name: "",
    opf_name: "",
    is_insured: "",
    // Срок истечения — конкретный месяц (date_end_from/to считаем отдельно)
    expires_month: "",
    // хранит date_end_from первого дня выбранного месяца
    expires_month_to: ""
    // хранит date_end_to последнего дня выбранного месяца
  };
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const expiryOptions = Array.from({ length: 12 }, (_, i) => getMonthOption(i));
  const [rowData, setRowData] = useState([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [editingDate, setEditingDate] = useState(false);
  const [dateInput, setDateInput] = useState("");
  const [availableRegions, setAvailableRegions] = useState([]);
  const [availableDistricts, setAvailableDistricts] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [newUser, setNewUser] = useState({ username: "", password: "", region: "" });
  const [userMgmtMsg, setUserMgmtMsg] = useState("");
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminTab, setAdminTab] = useState("users");
  const [logs, setLogs] = useState([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [logsUserFilter, setLogsUserFilter] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsDateFrom, setLogsDateFrom] = useState(null);
  const [logsDateTo, setLogsDateTo] = useState(null);
  const LOGS_PAGE_SIZE = 50;
  const [showFiles, setShowFiles] = useState(false);
  const [filesList, setFilesList] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileUploading, setFileUploading] = useState(false);
  const columnDefs = useMemo(() => [
    // Закреплённые слева
    {
      field: "bin",
      headerName: "\u0411\u0418\u041D",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      width: 150,
      pinned: "left",
      valueFormatter: binFormatter,
      // filterValueGetter позволяет AG Grid искать по строке с нулями
      filterValueGetter: (p) => p.data?.bin != null ? String(p.data.bin).padStart(12, "0") : ""
    },
    {
      field: "bin_name",
      headerName: "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 250
    },
    // Страховая компания
    {
      field: "system_delimiter_bin",
      headerName: "\u0411\u0418\u041D \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043E\u0439 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      width: 200,
      valueFormatter: binFormatter,
      filterValueGetter: (p) => p.data?.system_delimiter_bin != null ? String(p.data.system_delimiter_bin).padStart(12, "0") : ""
    },
    {
      field: "system_delimiter_bin_name",
      headerName: "\u0421\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044F",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 220
    },
    // Договор
    {
      field: "contract_number",
      headerName: "\u2116 \u0414\u043E\u0433\u043E\u0432\u043E\u0440\u0430",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 150
    },
    // Даты
    { field: "contract_date", headerName: "\u0414\u0430\u0442\u0430 \u0434\u043E\u0433\u043E\u0432\u043E\u0440\u0430", sortable: true, filter: "agDateColumnFilter", floatingFilter: true, minWidth: 150 },
    { field: "date_beg", headerName: "\u0414\u0430\u0442\u0430 \u043D\u0430\u0447\u0430\u043B\u0430", sortable: true, filter: "agDateColumnFilter", floatingFilter: true, minWidth: 140 },
    { field: "date_end", headerName: "\u0414\u0430\u0442\u0430 \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u044F", sortable: true, filter: "agDateColumnFilter", floatingFilter: true, minWidth: 150 },
    { field: "rescinding_date", headerName: "\u0414\u0430\u0442\u0430 \u0440\u0430\u0441\u0442\u043E\u0440\u0436\u0435\u043D\u0438\u044F", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 160 },
    // Финансы и сотрудники
    {
      field: "calculated_amount",
      headerName: "\u0421\u0443\u043C\u043C\u0430",
      sortable: true,
      filter: "agNumberColumnFilter",
      floatingFilter: true,
      minWidth: 140,
      valueFormatter: (p) => fmtNumber(p.value, 0)
    },
    { field: "count_employees", headerName: "\u0417\u0430\u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u043D\u044B\u0445", sortable: true, filter: "agNumberColumnFilter", floatingFilter: true, minWidth: 150 },
    { field: "total_employees_count", headerName: "\u0412\u0441\u0435\u0433\u043E \u0441\u043E\u0442\u0440.", sortable: true, filter: "agNumberColumnFilter", floatingFilter: true, minWidth: 130 },
    { field: "kol_12mes", headerName: "\u041A\u043E\u043B-\u0432\u043E 12 \u043C\u0435\u0441.", sortable: true, filter: "agNumberColumnFilter", floatingFilter: true, minWidth: 150 },
    { field: "fot_12mes", headerName: "\u0424\u041E\u0422 12 \u043C\u0435\u0441.", sortable: true, filter: "agNumberColumnFilter", floatingFilter: true, minWidth: 140 },
    { field: "esutd_akt_td", headerName: "ESUTD \u0430\u043A\u0442. \u0422\u0414", sortable: true, filter: "agNumberColumnFilter", floatingFilter: true, minWidth: 145 },
    // Местоположение
    { field: "obl_name", headerName: "\u041E\u0431\u043B\u0430\u0441\u0442\u044C", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 180 },
    { field: "rai_name", headerName: "\u0420\u0430\u0439\u043E\u043D", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 180 },
    { field: "address", headerName: "\u0410\u0434\u0440\u0435\u0441", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 280 },
    // Контакты
    { field: "phone", headerName: "\u0422\u0435\u043B\u0435\u0444\u043E\u043D", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 150 },
    // Руководитель
    {
      field: "leader_surname",
      headerName: "\u0420\u0443\u043A\u043E\u0432\u043E\u0434\u0438\u0442\u0435\u043B\u044C",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 220,
      valueGetter: (params) => {
        if (!params.data) return "";
        return `${params.data.leader_surname || ""} ${params.data.leader_name || ""} ${params.data.leader_middlename || ""}`.trim();
      }
    },
    // ОПФ и деятельность
    { field: "opf_name", headerName: "\u041E\u041F\u0424", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 200 },
    { field: "id_oked", headerName: "\u041A\u043E\u0434 \u041E\u041A\u042D\u0414", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 120 },
    { field: "name_oked", headerName: "\u0412\u0438\u0434 \u0434\u0435\u044F\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u0438 (\u041E\u041A\u042D\u0414)", sortable: true, filter: "agTextColumnFilter", floatingFilter: true, minWidth: 280 },
    // Доп. поля
    { field: "ip", headerName: "\u0418\u041F", sortable: true, filter: "agNumberColumnFilter", floatingFilter: true, minWidth: 90 },
    // ТИП и Флаг скрыты в таблице, но экспортируются в Excel
    { field: "tip", headerName: "\u0422\u0418\u041F", hide: true },
    { field: "flag_head", headerName: "\u0424\u043B\u0430\u0433", hide: true },
    {
      field: "is_insured",
      headerName: "\u0417\u0430\u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D",
      sortable: true,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 130,
      cellRenderer: (params) => {
        if (!params.data) return "";
        return params.value ? "\u2705 \u0414\u0430" : "\u274C \u041D\u0435\u0442";
      }
    }
  ], []);
  const defaultColDef = useMemo(() => ({
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    suppressMenu: false,
    wrapHeaderText: true,
    autoHeaderHeight: true
  }), []);
  const buildFilterParams = useCallback(() => {
    const params = {};
    if (filters.bin) params.bin = filters.bin;
    if (filters.bin_name) params.bin_name = filters.bin_name;
    if (filters.system_delimiter_bin) params.system_delimiter_bin = filters.system_delimiter_bin;
    if (filters.system_delimiter_bin_name) params.system_delimiter_bin_name = filters.system_delimiter_bin_name;
    if (filters.contract_number) params.contract_number = filters.contract_number;
    if (filters.contract_date_from) params.contract_date_from = filters.contract_date_from.toISOString().split("T")[0];
    if (filters.contract_date_to) params.contract_date_to = filters.contract_date_to.toISOString().split("T")[0];
    if (filters.date_end_from) params.date_end_from = filters.date_end_from.toISOString().split("T")[0];
    if (filters.date_end_to) params.date_end_to = filters.date_end_to.toISOString().split("T")[0];
    if (filters.obl_name) params.obl_name = filters.obl_name;
    if (filters.rai_name) params.rai_name = filters.rai_name;
    if (filters.opf_name) params.opf_name = filters.opf_name;
    if (filters.is_insured !== "") params.is_insured = parseInt(filters.is_insured);
    if (filters.expires_month) {
      params.date_end_from = filters.expires_month;
      params.date_end_to = filters.expires_month_to;
    }
    if (gridRef.current?.api) {
      const model = gridRef.current.api.getFilterModel();
      const textFields = [
        "bin",
        "bin_name",
        "system_delimiter_bin",
        "system_delimiter_bin_name",
        "contract_number",
        "obl_name",
        "rai_name",
        "address",
        "phone",
        "leader_surname",
        "opf_name",
        "id_oked",
        "name_oked"
      ];
      textFields.forEach((f) => {
        if (model[f]?.filter && !params[f]) {
          params[f] = model[f].filter;
        }
      });
    }
    return params;
  }, [filters]);
  const fetchMetrics = useCallback(async (overrideParams) => {
    try {
      const params = overrideParams ?? buildFilterParams();
      const response = await api.get("/api/metrics", { params });
      setMetrics(response.data);
    } catch (error) {
      console.error("Error fetching metrics:", error);
    }
  }, [buildFilterParams]);
  const fetchData = useCallback(async (page = 1, overrideParams) => {
    try {
      const base = overrideParams ?? buildFilterParams();
      const params = { ...base, page, page_size: pageSize };
      const response = await api.get("/api/records", { params });
      setRowData(response.data.items);
      setTotalRecords(response.data.total);
      setCurrentPage(page);
    } catch (error) {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0434\u0430\u043D\u043D\u044B\u0445");
    }
  }, [buildFilterParams]);
  const lastFetchedFilterModelRef = useRef("");
  const fetchAll = useCallback(async (page = 1) => {
    setIsLoading(true);
    try {
      const filterParams = buildFilterParams();
      lastFetchedFilterModelRef.current = JSON.stringify(
        gridRef.current?.api?.getFilterModel() || {}
      );
      await Promise.all([
        fetchMetrics(filterParams),
        fetchData(page, filterParams)
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [buildFilterParams, fetchMetrics, fetchData]);
  const fetchDataRef = useRef(fetchAll);
  useEffect(() => {
    fetchDataRef.current = fetchAll;
  }, [fetchAll]);
  const filterChangeTimer = useRef(null);
  const onAgGridFilterChanged = useCallback(() => {
    const currentModel = JSON.stringify(gridRef.current?.api?.getFilterModel() || {});
    if (currentModel === lastFetchedFilterModelRef.current) return;
    clearTimeout(filterChangeTimer.current);
    filterChangeTimer.current = setTimeout(() => {
      fetchDataRef.current(1);
    }, 600);
  }, []);
  const fetchLastUpdate = useCallback(async () => {
    try {
      const res = await api.get("/api/settings/last_update");
      setLastUpdate(res.data.last_update);
    } catch {
    }
  }, []);
  const saveLastUpdate = async () => {
    try {
      await api.put("/api/settings/last_update", { last_update: dateInput });
      setLastUpdate(dateInput);
      setEditingDate(false);
    } catch {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u044F");
    }
  };
  const fetchRegions = useCallback(async () => {
    try {
      const res = await api.get("/api/regions");
      setAvailableRegions(res.data);
    } catch {
    }
  }, []);
  const fetchDistricts = useCallback(async (region) => {
    if (!region) {
      setAvailableDistricts([]);
      return;
    }
    try {
      const res = await api.get("/api/districts", { params: { region } });
      setAvailableDistricts(res.data);
    } catch {
    }
  }, []);
  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get("/api/users");
      setUsersList(res.data);
    } catch {
    }
  }, []);
  const createRegionalUser = async () => {
    if (!newUser.username || !newUser.password) {
      setUserMgmtMsg("\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u0432\u0441\u0435 \u043F\u043E\u043B\u044F");
      return;
    }
    try {
      await api.post("/api/users", { ...newUser, role: "user", region: newUser.region || null });
      setNewUser({ username: "", password: "", region: "" });
      setUserMgmtMsg("\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C \u0441\u043E\u0437\u0434\u0430\u043D");
      fetchUsers();
    } catch (e) {
      setUserMgmtMsg(e.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430");
    }
  };
  const deleteUser = async (id) => {
    if (!window.confirm("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F?")) return;
    try {
      await api.delete(`/api/users/${id}`);
      fetchUsers();
    } catch (e) {
      toast.error(e.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F");
    }
  };
  const toLocalISODate = (d) => {
    if (!d) return void 0;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const fetchLogs = useCallback(async (page = 1, username = "", from = null, to = null) => {
    setLogsLoading(true);
    try {
      const res = await api.get("/api/logs", {
        params: {
          page,
          page_size: LOGS_PAGE_SIZE,
          username: username || void 0,
          date_from: toLocalISODate(from),
          date_to: toLocalISODate(to)
        }
      });
      setLogs(res.data.items);
      setLogsTotal(res.data.total);
      setLogsPage(res.data.page);
    } catch (e) {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u043B\u043E\u0433\u043E\u0432");
    } finally {
      setLogsLoading(false);
    }
  }, []);
  const openAdminPanel = () => {
    setShowAdmin(true);
    setAdminTab("users");
    fetchUsers();
  };
  const selectAdminTab = (tab) => {
    setAdminTab(tab);
    if (tab === "users") fetchUsers();
    if (tab === "logs") fetchLogs(1, logsUserFilter, logsDateFrom, logsDateTo);
    if (tab === "files") fetchFiles();
  };
  const downloadLoginStats = async () => {
    try {
      const res = await api.get("/api/logs/export", {
        params: { date_from: toLocalISODate(logsDateFrom), date_to: toLocalISODate(logsDateTo) },
        responseType: "blob"
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      const from = logsDateFrom ? toLocalISODate(logsDateFrom) : "\u0432\u0435\u0441\u044C-\u043F\u0435\u0440\u0438\u043E\u0434";
      const to = logsDateTo ? toLocalISODate(logsDateTo) : "";
      link.setAttribute("download", `\u0432\u0445\u043E\u0434\u044B_${from}${to ? "_" + to : ""}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success("\u0424\u0430\u0439\u043B \u0441\u043A\u0430\u0447\u0430\u043D");
    } catch {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u0438 \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u0438");
    }
  };
  const formatBytes = (bytes) => {
    if (!bytes) return "\u2014";
    const units = ["\u0411", "\u041A\u0411", "\u041C\u0411", "\u0413\u0411"];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };
  const fetchFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const res = await api.get("/api/files");
      setFilesList(res.data);
    } catch {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0441\u043F\u0438\u0441\u043A\u0430 \u0444\u0430\u0439\u043B\u043E\u0432");
    } finally {
      setFilesLoading(false);
    }
  }, []);
  const openFiles = () => {
    setShowFiles(true);
    fetchFiles();
  };
  const downloadFile = async (f) => {
    try {
      const res = await api.get(`/api/files/${f.id}/download`, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", f.original_name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u0438 \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u0438");
    }
  };
  const uploadSharedFile = async (file) => {
    if (!file) return;
    setFileUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      await api.post("/api/files", formData, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("\u0424\u0430\u0439\u043B \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D");
      fetchFiles();
    } catch (err) {
      toast.error(err.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438");
    } finally {
      setFileUploading(false);
    }
  };
  const deleteSharedFile = async (f) => {
    if (!window.confirm(`\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0444\u0430\u0439\u043B \xAB${f.original_name}\xBB?`)) return;
    try {
      await api.delete(`/api/files/${f.id}`);
      fetchFiles();
    } catch (err) {
      toast.error(err.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F");
    }
  };
  const applyFilters = () => {
    setCurrentPage(1);
    fetchAll(1);
  };
  const resetFilters = () => {
    if (gridRef.current?.api) gridRef.current.api.setFilterModel(null);
    setFilters(EMPTY_FILTERS);
    setTimeout(() => fetchAll(1), 0);
  };
  const downloadExcel = async () => {
    try {
      const params = buildFilterParams();
      const response = await api.get("/api/records/download", { params, responseType: "blob" });
      const blob = new Blob([response.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `insurance_records_${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success("\u0424\u0430\u0439\u043B \u0441\u043A\u0430\u0447\u0430\u043D");
    } catch {
      toast.error("\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u0438 \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u0438");
    }
  };
  const handleUpload = async (file) => {
    if (!file) return;
    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      await api.post("/api/upload", formData, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("\u0424\u0430\u0439\u043B \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D!");
      fetchMetrics();
      fetchData(1);
    } catch (error) {
      toast.error(error.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u0430\u0439\u043B\u0430");
    } finally {
      setIsUploading(false);
    }
  };
  const handleOppvUpload = async (file) => {
    if (!file) return;
    setIsOppvUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await api.post("/api/oppv/upload", formData, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success(res.data?.message || "\u0424\u0430\u0439\u043B \u041E\u041F\u0412\u0420 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D");
    } catch (error) {
      toast.error(error.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u0430\u0439\u043B\u0430");
    } finally {
      setIsOppvUploading(false);
    }
  };
  const toggleAppvr = async (u) => {
    try {
      await api.patch(`/api/users/${u.id}`, { appvr_access: u.appvr_access ? 0 : 1 });
      fetchUsers();
    } catch (e) {
      toast.error(e.response?.data?.detail || "\u041E\u0448\u0438\u0431\u043A\u0430");
    }
  };
  const totalPages = Math.ceil(totalRecords / pageSize);
  const goToPage = (page) => {
    if (page >= 1 && page <= totalPages) fetchAll(page);
  };
  useEffect(() => {
    fetchAll(1);
    fetchLastUpdate();
    if (isAdmin()) {
      fetchRegions();
      fetchUsers();
    } else if (user?.region) {
      fetchDistricts(user.region);
    }
  }, []);
  const onFirstDataRendered = useCallback((params) => {
    params.api.autoSizeAllColumns(false);
  }, []);
  return /* @__PURE__ */ React.createElement("div", { className: "dashboard" }, /* @__PURE__ */ React.createElement("header", { className: "dashboard-header" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h1", null, "\u0413\u043E\u0441\u0443\u0434\u0430\u0440\u0441\u0442\u0432\u0435\u043D\u043D\u0430\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044F \u043F\u043E \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u0438\u044E \u0436\u0438\u0437\u043D\u0438"), /* @__PURE__ */ React.createElement("div", { className: "last-update-line" }, editingDate ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", null, "\u0414\u0430\u0442\u0430 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F: "), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      value: dateInput,
      onChange: (e) => setDateInput(e.target.value),
      placeholder: "\u0434\u0434.\u043C\u043C.\u0433\u0433\u0433\u0433",
      style: { width: 110, fontSize: 13, padding: "2px 6px", borderRadius: 4, border: "1px solid #aaa" }
    }
  ), /* @__PURE__ */ React.createElement("button", { onClick: saveLastUpdate, style: { marginLeft: 6, fontSize: 12, padding: "2px 8px", background: "#4a6fa5", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" } }, "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C"), /* @__PURE__ */ React.createElement("button", { onClick: () => setEditingDate(false), style: { marginLeft: 4, fontSize: 12, padding: "2px 8px", background: "#eee", border: "none", borderRadius: 4, cursor: "pointer" } }, "\u041E\u0442\u043C\u0435\u043D\u0430")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", null, "\u0414\u0430\u0442\u0430 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F \u0434\u0430\u043D\u043D\u044B\u0445: ", /* @__PURE__ */ React.createElement("b", null, lastUpdate || "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0430")), isAdmin() && /* @__PURE__ */ React.createElement("button", { onClick: () => {
    setDateInput(lastUpdate || "");
    setEditingDate(true);
  }, style: { marginLeft: 8, fontSize: 12, padding: "2px 8px", background: "transparent", border: "1px solid #aaa", borderRadius: 4, cursor: "pointer" } }, "\u270F\uFE0F \u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C")))), /* @__PURE__ */ React.createElement("div", { className: "user-info" }, canAppvr && /* @__PURE__ */ React.createElement("div", { className: "section-toggle" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: section === "insurance" ? "active" : "",
      onClick: () => setSection("insurance")
    },
    /* @__PURE__ */ React.createElement(Shield, { size: 16 }),
    " \u0421\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u0438\u0435"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: section === "oppv" ? "active" : "",
      onClick: () => setSection("oppv")
    },
    /* @__PURE__ */ React.createElement(Coins, { size: 16 }),
    " \u0410\u043D\u0430\u043B\u0438\u0437 \u041E\u041F\u041F\u0412"
  )), /* @__PURE__ */ React.createElement("span", null, user?.username), !isAdmin() && /* @__PURE__ */ React.createElement("button", { onClick: openFiles, className: "files-btn" }, /* @__PURE__ */ React.createElement(FolderOpen, { size: 18 }), " \u0424\u0430\u0439\u043B\u044B"), isAdmin() && /* @__PURE__ */ React.createElement("button", { onClick: openAdminPanel, className: "logs-btn" }, /* @__PURE__ */ React.createElement(Settings, { size: 18 }), " \u0410\u0434\u043C\u0438\u043D \u043F\u0430\u043D\u0435\u043B\u044C"), /* @__PURE__ */ React.createElement("button", { onClick: logout, className: "logout-btn" }, /* @__PURE__ */ React.createElement(LogOut, { size: 18 }), " \u0412\u044B\u0439\u0442\u0438"))), showFiles && /* @__PURE__ */ React.createElement("div", { className: "logs-overlay", onClick: () => setShowFiles(false) }, /* @__PURE__ */ React.createElement("div", { className: "logs-modal", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "logs-modal-header" }, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement(FolderOpen, { size: 20 }), " \u0424\u0430\u0439\u043B\u044B"), /* @__PURE__ */ React.createElement("button", { onClick: () => setShowFiles(false), className: "logs-close-btn" }, /* @__PURE__ */ React.createElement(X, { size: 20 }))), /* @__PURE__ */ React.createElement("div", { className: "logs-table-wrap" }, filesLoading ? /* @__PURE__ */ React.createElement("div", { style: { padding: 40, textAlign: "center", color: "#666" } }, "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...") : filesList.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { padding: 40, textAlign: "center", color: "#666" } }, "\u0424\u0430\u0439\u043B\u043E\u0432 \u043D\u0435\u0442") : /* @__PURE__ */ React.createElement("table", { className: "users-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435"), /* @__PURE__ */ React.createElement("th", null, "\u0420\u0430\u0437\u043C\u0435\u0440"), /* @__PURE__ */ React.createElement("th", null, "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u043B"), /* @__PURE__ */ React.createElement("th", null, "\u0414\u0430\u0442\u0430"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, filesList.map((f) => /* @__PURE__ */ React.createElement("tr", { key: f.id }, /* @__PURE__ */ React.createElement("td", null, f.original_name), /* @__PURE__ */ React.createElement("td", null, formatBytes(f.size_bytes)), /* @__PURE__ */ React.createElement("td", null, f.uploaded_by || "\u2014"), /* @__PURE__ */ React.createElement("td", null, new Date(f.uploaded_at).toLocaleString("ru-RU")), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" } }, /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => downloadFile(f),
      className: "download-btn",
      style: { padding: "4px 10px", fontSize: 12 }
    },
    /* @__PURE__ */ React.createElement(Download, { size: 14 }),
    " \u0421\u043A\u0430\u0447\u0430\u0442\u044C"
  )))))))))), showAdmin && /* @__PURE__ */ React.createElement("div", { className: "logs-overlay", onClick: () => setShowAdmin(false) }, /* @__PURE__ */ React.createElement("div", { className: "logs-modal admin-modal", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "logs-modal-header" }, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement(Settings, { size: 20 }), " \u0410\u0434\u043C\u0438\u043D \u043F\u0430\u043D\u0435\u043B\u044C"), /* @__PURE__ */ React.createElement("button", { onClick: () => setShowAdmin(false), className: "logs-close-btn" }, /* @__PURE__ */ React.createElement(X, { size: 20 }))), /* @__PURE__ */ React.createElement("div", { className: "admin-tabs" }, /* @__PURE__ */ React.createElement("button", { className: adminTab === "users" ? "active" : "", onClick: () => selectAdminTab("users") }, /* @__PURE__ */ React.createElement(Users, { size: 16 }), " \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0438"), /* @__PURE__ */ React.createElement("button", { className: adminTab === "upload" ? "active" : "", onClick: () => selectAdminTab("upload") }, /* @__PURE__ */ React.createElement(Upload, { size: 16 }), " \u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 Excel"), /* @__PURE__ */ React.createElement("button", { className: adminTab === "oppv" ? "active" : "", onClick: () => selectAdminTab("oppv") }, /* @__PURE__ */ React.createElement(Coins, { size: 16 }), " \u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u041E\u041F\u0412\u0420"), /* @__PURE__ */ React.createElement("button", { className: adminTab === "logs" ? "active" : "", onClick: () => selectAdminTab("logs") }, /* @__PURE__ */ React.createElement(ScrollText, { size: 16 }), " \u041B\u043E\u0433\u0438 \u0432\u0445\u043E\u0434\u043E\u0432"), /* @__PURE__ */ React.createElement("button", { className: adminTab === "files" ? "active" : "", onClick: () => selectAdminTab("files") }, /* @__PURE__ */ React.createElement(FolderOpen, { size: 16 }), " \u0424\u0430\u0439\u043B\u044B")), adminTab === "users" && /* @__PURE__ */ React.createElement("div", { className: "admin-tab-body" }, /* @__PURE__ */ React.createElement("div", { className: "user-create-form" }, /* @__PURE__ */ React.createElement(
    "select",
    {
      value: newUser.region,
      onChange: (e) => setNewUser({ ...newUser, region: e.target.value })
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 \u0412\u0435\u0441\u044C \u041A\u0430\u0437\u0430\u0445\u0441\u0442\u0430\u043D \u2014"),
    availableRegions.map((r) => /* @__PURE__ */ React.createElement("option", { key: r, value: r }, r))
  ), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      placeholder: "\u041B\u043E\u0433\u0438\u043D (\u043B\u0430\u0442\u0438\u043D\u0438\u0446\u0430)",
      value: newUser.username,
      onChange: (e) => setNewUser({ ...newUser, username: e.target.value })
    }
  ), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      placeholder: "\u041F\u0430\u0440\u043E\u043B\u044C",
      value: newUser.password,
      onChange: (e) => setNewUser({ ...newUser, password: e.target.value })
    }
  ), /* @__PURE__ */ React.createElement("button", { onClick: createRegionalUser, className: "apply-btn", style: { padding: "8px 16px" } }, "\u0421\u043E\u0437\u0434\u0430\u0442\u044C"), userMgmtMsg && /* @__PURE__ */ React.createElement("span", { style: { marginLeft: 8, color: userMgmtMsg.includes("\u0441\u043E\u0437\u0434\u0430\u043D") ? "green" : "red" } }, userMgmtMsg)), /* @__PURE__ */ React.createElement("table", { className: "users-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "\u041B\u043E\u0433\u0438\u043D"), /* @__PURE__ */ React.createElement("th", null, "\u0420\u043E\u043B\u044C"), /* @__PURE__ */ React.createElement("th", null, "\u0420\u0435\u0433\u0438\u043E\u043D"), /* @__PURE__ */ React.createElement("th", null, "\u0414\u043E\u0441\u0442\u0443\u043F \u043A \u041E\u041F\u0412\u0420"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, usersList.map((u) => /* @__PURE__ */ React.createElement("tr", { key: u.id }, /* @__PURE__ */ React.createElement("td", null, u.username), /* @__PURE__ */ React.createElement("td", null, u.role), /* @__PURE__ */ React.createElement("td", null, u.region || "\u2014 \u0432\u0441\u0435 \u0440\u0435\u0433\u0438\u043E\u043D\u044B \u2014"), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "center" } }, u.role === "admin" ? /* @__PURE__ */ React.createElement("span", { title: "\u0410\u0434\u043C\u0438\u043D\u0430\u043C \u0434\u043E\u0441\u0442\u0443\u043F \u043E\u0442\u043A\u0440\u044B\u0442 \u0432\u0441\u0435\u0433\u0434\u0430" }, "\u2713") : /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "checkbox",
      checked: !!u.appvr_access,
      onChange: () => toggleAppvr(u),
      style: { width: 18, height: 18, cursor: "pointer" }
    }
  )), /* @__PURE__ */ React.createElement("td", null, !["admin", "user"].includes(u.username) && /* @__PURE__ */ React.createElement("button", { onClick: () => deleteUser(u.id), className: "reset-btn", style: { padding: "4px 10px", fontSize: 12 } }, "\u0423\u0434\u0430\u043B\u0438\u0442\u044C"))))))), adminTab === "upload" && /* @__PURE__ */ React.createElement("div", { className: "admin-tab-body admin-tab-body--upload" }, /* @__PURE__ */ React.createElement("p", { style: { fontWeight: 600, marginTop: 0, marginBottom: 12 } }, "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 Excel-\u0444\u0430\u0439\u043B \u2014 \u0442\u0435\u043A\u0443\u0449\u0438\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0431\u0443\u0434\u0443\u0442 \u0437\u0430\u043C\u0435\u043D\u0435\u043D\u044B."), /* @__PURE__ */ React.createElement(
    FileDropzone,
    {
      onFile: handleUpload,
      uploading: isUploading,
      accept: ".xlsx,.xls",
      label: "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B",
      className: "dropzone--full dropzone--tall"
    }
  )), adminTab === "oppv" && /* @__PURE__ */ React.createElement("div", { className: "admin-tab-body admin-tab-body--upload" }, /* @__PURE__ */ React.createElement("p", { style: { fontWeight: 600, marginTop: 0, marginBottom: 12 } }, "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 Excel \xAB\u041F\u0435\u043D\u0441\u0438\u043E\u043D\u043D\u044B\u0435 \u0432\u0437\u043D\u043E\u0441\u044B \u0440\u0430\u0431\u043E\u0442\u043D\u0438\u043A\u043E\u0432\xBB (\u041E\u041F\u0412\u0420) \u2014 \u0442\u0435\u043A\u0443\u0449\u0438\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0440\u0430\u0437\u0434\u0435\u043B\u0430 \u0431\u0443\u0434\u0443\u0442 \u0437\u0430\u043C\u0435\u043D\u0435\u043D\u044B."), /* @__PURE__ */ React.createElement(
    FileDropzone,
    {
      onFile: handleOppvUpload,
      uploading: isOppvUploading,
      accept: ".xlsx,.xls",
      label: "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u0430\u0439\u043B \u041E\u041F\u0412\u0420",
      className: "dropzone--full dropzone--tall"
    }
  )), adminTab === "files" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "logs-toolbar", style: { flexDirection: "column", alignItems: "flex-start", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 600 } }, "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B"), /* @__PURE__ */ React.createElement(
    FileDropzone,
    {
      onFile: uploadSharedFile,
      uploading: fileUploading,
      label: "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B",
      className: "dropzone--full"
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "logs-table-wrap" }, filesLoading ? /* @__PURE__ */ React.createElement("div", { style: { padding: 40, textAlign: "center", color: "#666" } }, "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...") : filesList.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { padding: 40, textAlign: "center", color: "#666" } }, "\u0424\u0430\u0439\u043B\u043E\u0432 \u043D\u0435\u0442") : /* @__PURE__ */ React.createElement("table", { className: "users-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435"), /* @__PURE__ */ React.createElement("th", null, "\u0420\u0430\u0437\u043C\u0435\u0440"), /* @__PURE__ */ React.createElement("th", null, "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u043B"), /* @__PURE__ */ React.createElement("th", null, "\u0414\u0430\u0442\u0430"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, filesList.map((f) => /* @__PURE__ */ React.createElement("tr", { key: f.id }, /* @__PURE__ */ React.createElement("td", null, f.original_name), /* @__PURE__ */ React.createElement("td", null, formatBytes(f.size_bytes)), /* @__PURE__ */ React.createElement("td", null, f.uploaded_by || "\u2014"), /* @__PURE__ */ React.createElement("td", null, new Date(f.uploaded_at).toLocaleString("ru-RU")), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" } }, /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => downloadFile(f),
      className: "download-btn",
      style: { padding: "4px 10px", fontSize: 12 }
    },
    /* @__PURE__ */ React.createElement(Download, { size: 14 }),
    " \u0421\u043A\u0430\u0447\u0430\u0442\u044C"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => deleteSharedFile(f),
      className: "reset-btn",
      style: { padding: "4px 10px", fontSize: 12 }
    },
    /* @__PURE__ */ React.createElement(Trash2, { size: 14 })
  ))))))))), adminTab === "logs" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "logs-toolbar" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      placeholder: "\u0424\u0438\u043B\u044C\u0442\u0440 \u043F\u043E \u043B\u043E\u0433\u0438\u043D\u0443...",
      value: logsUserFilter,
      onChange: (e) => setLogsUserFilter(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") fetchLogs(1, logsUserFilter, logsDateFrom, logsDateTo);
      }
    }
  ), /* @__PURE__ */ React.createElement(
    DatePicker,
    {
      selected: logsDateFrom,
      onChange: (d) => setLogsDateFrom(d),
      dateFormat: "dd.MM.yyyy",
      placeholderText: "\u0414\u0430\u0442\u0430 \u0441",
      isClearable: true,
      className: "logs-date-input"
    }
  ), /* @__PURE__ */ React.createElement(
    DatePicker,
    {
      selected: logsDateTo,
      onChange: (d) => setLogsDateTo(d),
      dateFormat: "dd.MM.yyyy",
      placeholderText: "\u0414\u0430\u0442\u0430 \u043F\u043E",
      isClearable: true,
      className: "logs-date-input"
    }
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => fetchLogs(1, logsUserFilter, logsDateFrom, logsDateTo),
      className: "apply-btn",
      style: { padding: "8px 16px" }
    },
    /* @__PURE__ */ React.createElement(Search, { size: 16 }),
    " \u041D\u0430\u0439\u0442\u0438"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: downloadLoginStats,
      className: "download-btn",
      style: { padding: "8px 16px" },
      title: "Excel: \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0440\u0430\u0437 \u043A\u0430\u0436\u0434\u044B\u0439 \u0430\u043A\u043A\u0430\u0443\u043D\u0442 \u0437\u0430\u0445\u043E\u0434\u0438\u043B"
    },
    /* @__PURE__ */ React.createElement(Download, { size: 16 }),
    " \u0412\u044B\u0433\u0440\u0443\u0437\u043A\u0430"
  )), /* @__PURE__ */ React.createElement("div", { className: "logs-subbar" }, /* @__PURE__ */ React.createElement("span", null, logsDateFrom || logsDateTo ? "\u0412\u044B\u0433\u0440\u0443\u0437\u043A\u0430 \u0437\u0430 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u043F\u0435\u0440\u0438\u043E\u0434" : "\u0412\u044B\u0433\u0440\u0443\u0437\u043A\u0430 \u0437\u0430 \u0432\u0441\u0451 \u0432\u0440\u0435\u043C\u044F \u2014 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0430\u0442\u044B, \u0447\u0442\u043E\u0431\u044B \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u0442\u044C \u043F\u0435\u0440\u0438\u043E\u0434"), /* @__PURE__ */ React.createElement("span", { style: { marginLeft: "auto" } }, "\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u043F\u0438\u0441\u0435\u0439: ", /* @__PURE__ */ React.createElement("b", null, logsTotal.toLocaleString()))), /* @__PURE__ */ React.createElement("div", { className: "logs-table-wrap" }, logsLoading ? /* @__PURE__ */ React.createElement("div", { style: { padding: 40, textAlign: "center", color: "#666" } }, "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...") : logs.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { padding: 40, textAlign: "center", color: "#666" } }, "\u0417\u0430\u043F\u0438\u0441\u0435\u0439 \u043D\u0435\u0442") : /* @__PURE__ */ React.createElement("table", { className: "users-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "\u0414\u0430\u0442\u0430 \u0438 \u0432\u0440\u0435\u043C\u044F"), /* @__PURE__ */ React.createElement("th", null, "\u041B\u043E\u0433\u0438\u043D"), /* @__PURE__ */ React.createElement("th", null, "\u0420\u043E\u043B\u044C"), /* @__PURE__ */ React.createElement("th", null, "\u0420\u0435\u0433\u0438\u043E\u043D"), /* @__PURE__ */ React.createElement("th", null, "IP-\u0430\u0434\u0440\u0435\u0441"))), /* @__PURE__ */ React.createElement("tbody", null, logs.map((l) => /* @__PURE__ */ React.createElement("tr", { key: l.id }, /* @__PURE__ */ React.createElement("td", null, new Date(l.logged_at).toLocaleString("ru-RU")), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("b", null, l.username)), /* @__PURE__ */ React.createElement("td", null, l.role), /* @__PURE__ */ React.createElement("td", null, l.region || "\u2014 \u0432\u0441\u0435 \u0440\u0435\u0433\u0438\u043E\u043D\u044B \u2014"), /* @__PURE__ */ React.createElement("td", null, l.ip_address || "\u2014")))))), logsTotal > LOGS_PAGE_SIZE && /* @__PURE__ */ React.createElement("div", { className: "logs-pagination" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      disabled: logsPage <= 1,
      onClick: () => fetchLogs(logsPage - 1, logsUserFilter, logsDateFrom, logsDateTo)
    },
    "\u2190 \u041D\u0430\u0437\u0430\u0434"
  ), /* @__PURE__ */ React.createElement("span", null, "\u0421\u0442\u0440. ", logsPage, " \u0438\u0437 ", Math.ceil(logsTotal / LOGS_PAGE_SIZE)), /* @__PURE__ */ React.createElement(
    "button",
    {
      disabled: logsPage >= Math.ceil(logsTotal / LOGS_PAGE_SIZE),
      onClick: () => fetchLogs(logsPage + 1, logsUserFilter, logsDateFrom, logsDateTo)
    },
    "\u0412\u043F\u0435\u0440\u0451\u0434 \u2192"
  ))))), section === "oppv" && /* @__PURE__ */ React.createElement(OppvSection, null), section === "insurance" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "metrics" }, /* @__PURE__ */ React.createElement("div", { className: "metric-card" }, /* @__PURE__ */ React.createElement(Users, { className: "metric-icon", size: 32 }), /* @__PURE__ */ React.createElement("div", { className: "metric-info" }, /* @__PURE__ */ React.createElement("span", { className: "metric-value" }, metrics.total_bins.toLocaleString()), /* @__PURE__ */ React.createElement("span", { className: "metric-label" }, "\u0412\u0441\u0435\u0433\u043E \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0439"))), /* @__PURE__ */ React.createElement("div", { className: "metric-card insured" }, /* @__PURE__ */ React.createElement(Shield, { className: "metric-icon", size: 32 }), /* @__PURE__ */ React.createElement("div", { className: "metric-info" }, /* @__PURE__ */ React.createElement("span", { className: "metric-value" }, metrics.insured_bins.toLocaleString()), /* @__PURE__ */ React.createElement("span", { className: "metric-label" }, "\u0417\u0430\u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u044B"))), /* @__PURE__ */ React.createElement("div", { className: "metric-card not-insured" }, /* @__PURE__ */ React.createElement(ShieldOff, { className: "metric-icon", size: 32 }), /* @__PURE__ */ React.createElement("div", { className: "metric-info" }, /* @__PURE__ */ React.createElement("span", { className: "metric-value" }, metrics.not_insured_bins.toLocaleString()), /* @__PURE__ */ React.createElement("span", { className: "metric-label" }, "\u041D\u0435 \u0437\u0430\u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u044B")))), /* @__PURE__ */ React.createElement("div", { className: "filters-section" }, /* @__PURE__ */ React.createElement("h3", null, /* @__PURE__ */ React.createElement(Filter, { size: 20 }), " \u0424\u0438\u043B\u044C\u0442\u0440\u044B"), /* @__PURE__ */ React.createElement("div", { className: "filters-grid" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u0411\u0418\u041D"), /* @__PURE__ */ React.createElement(
    SuggestInput,
    {
      field: "bin",
      value: filters.bin,
      onChange: (v) => setFilters({ ...filters, bin: v }),
      placeholder: "\u041F\u043E\u0438\u0441\u043A \u043F\u043E \u0411\u0418\u041D..."
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438"), /* @__PURE__ */ React.createElement(
    SuggestInput,
    {
      field: "bin_name",
      value: filters.bin_name,
      onChange: (v) => setFilters({ ...filters, bin_name: v }),
      placeholder: "\u041F\u043E\u0438\u0441\u043A \u043F\u043E \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044E..."
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u0411\u0418\u041D \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043E\u0439 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438"), /* @__PURE__ */ React.createElement(
    SuggestInput,
    {
      field: "system_delimiter_bin",
      value: filters.system_delimiter_bin,
      onChange: (v) => setFilters({ ...filters, system_delimiter_bin: v }),
      placeholder: "\u0411\u0418\u041D \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043E\u0439..."
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u0421\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044F"), /* @__PURE__ */ React.createElement(
    SuggestInput,
    {
      field: "system_delimiter_bin_name",
      value: filters.system_delimiter_bin_name,
      onChange: (v) => setFilters({ ...filters, system_delimiter_bin_name: v }),
      placeholder: "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043E\u0439..."
    }
  )), isAdmin() && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u041E\u0431\u043B\u0430\u0441\u0442\u044C"), /* @__PURE__ */ React.createElement(
    "select",
    {
      value: filters.obl_name,
      onChange: (e) => {
        const val = e.target.value;
        setFilters({ ...filters, obl_name: val, rai_name: "" });
        fetchDistricts(val);
      }
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u0412\u0441\u0435 \u043E\u0431\u043B\u0430\u0441\u0442\u0438"),
    availableRegions.map((r) => /* @__PURE__ */ React.createElement("option", { key: r, value: r }, r))
  )), (isAdmin() ? filters.obl_name : user?.region) && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u0420\u0430\u0439\u043E\u043D"), /* @__PURE__ */ React.createElement(
    "select",
    {
      value: filters.rai_name,
      onChange: (e) => setFilters({ ...filters, rai_name: e.target.value })
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u0412\u0441\u0435 \u0440\u0430\u0439\u043E\u043D\u044B"),
    availableDistricts.map((d) => /* @__PURE__ */ React.createElement("option", { key: d, value: d }, d))
  )), /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u0421\u0442\u0430\u0442\u0443\u0441"), /* @__PURE__ */ React.createElement(
    "select",
    {
      value: filters.is_insured,
      onChange: (e) => setFilters({ ...filters, is_insured: e.target.value })
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u0412\u0441\u0435"),
    /* @__PURE__ */ React.createElement("option", { value: "1" }, "\u0417\u0430\u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u044B"),
    /* @__PURE__ */ React.createElement("option", { value: "0" }, "\u041D\u0435 \u0437\u0430\u0441\u0442\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u044B")
  )), /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("label", null, "\u0421\u0440\u043E\u043A \u0438\u0441\u0442\u0435\u0447\u0435\u043D\u0438\u044F"), /* @__PURE__ */ React.createElement(
    "select",
    {
      value: filters.expires_month,
      onChange: (e) => {
        const opt = expiryOptions.find((o) => o.value === e.target.value);
        setFilters({
          ...filters,
          expires_month: opt ? opt.date_end_from : "",
          expires_month_to: opt ? opt.date_end_to : ""
        });
      }
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u0412\u0441\u0435"),
    expiryOptions.map((o) => /* @__PURE__ */ React.createElement("option", { key: o.value, value: o.value }, o.label))
  ))), /* @__PURE__ */ React.createElement("div", { className: "filter-actions" }, /* @__PURE__ */ React.createElement("button", { onClick: applyFilters, className: "apply-btn" }, /* @__PURE__ */ React.createElement(Search, { size: 18 }), " \u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C \u0444\u0438\u043B\u044C\u0442\u0440\u044B"), /* @__PURE__ */ React.createElement("button", { onClick: resetFilters, className: "reset-btn" }, "\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C"), /* @__PURE__ */ React.createElement("button", { onClick: downloadExcel, className: "download-btn" }, /* @__PURE__ */ React.createElement(Download, { size: 18 }), " \u0421\u043A\u0430\u0447\u0430\u0442\u044C Excel"))), /* @__PURE__ */ React.createElement("div", { className: "table-section" }, isLoading && /* @__PURE__ */ React.createElement("div", { className: "loading-bar" }, /* @__PURE__ */ React.createElement("div", { className: "loading-bar-inner" })), /* @__PURE__ */ React.createElement("div", { className: "table-header" }, /* @__PURE__ */ React.createElement("span", null, "\u0412\u0441\u0435\u0433\u043E: ", totalRecords.toLocaleString(), " \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0439"), /* @__PURE__ */ React.createElement("div", { className: "pagination" }, /* @__PURE__ */ React.createElement("button", { onClick: () => goToPage(currentPage - 1), disabled: currentPage === 1 }, "\u2190 \u041D\u0430\u0437\u0430\u0434"), /* @__PURE__ */ React.createElement("span", null, "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ", currentPage, " \u0438\u0437 ", totalPages), /* @__PURE__ */ React.createElement("button", { onClick: () => goToPage(currentPage + 1), disabled: currentPage === totalPages }, "\u0412\u043F\u0435\u0440\u0435\u0434 \u2192"))), /* @__PURE__ */ React.createElement("div", { className: "ag-theme-alpine", style: { height: 650, width: "100%" } }, /* @__PURE__ */ React.createElement(
    AgGridReact,
    {
      ref: gridRef,
      rowData,
      columnDefs,
      defaultColDef,
      pagination: false,
      domLayout: "normal",
      enableCellTextSelection: true,
      suppressClipboard: false,
      floatingFiltersHeight: 40,
      onFirstDataRendered,
      onFilterChanged: onAgGridFilterChanged
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "pagination-bottom" }, /* @__PURE__ */ React.createElement("button", { onClick: () => goToPage(currentPage - 1), disabled: currentPage === 1 }, "\u2190 \u041D\u0430\u0437\u0430\u0434"), /* @__PURE__ */ React.createElement("span", null, "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ", currentPage, " \u0438\u0437 ", totalPages), /* @__PURE__ */ React.createElement("button", { onClick: () => goToPage(currentPage + 1), disabled: currentPage === totalPages }, "\u0412\u043F\u0435\u0440\u0435\u0434 \u2192")))));
};
export default Dashboard;
