(function () {
  "use strict";

  angular
    .module("groceryApp", [])
    .config(["$httpProvider", function ($httpProvider) {
      // Attach JWT token to every request
      $httpProvider.interceptors.push("authInterceptor");
    }])
    .factory("authInterceptor", ["$window", "$q", function ($window, $q) {
      return {
        request: function (config) {
          var token = $window.localStorage.getItem("jwt_token");
          if (token) {
            config.headers = config.headers || {};
            config.headers.Authorization = "Bearer " + token;
          }
          return config;
        },
        responseError: function (rejection) {
          if (rejection.status === 401) {
            $window.localStorage.removeItem("jwt_token");
            $window.localStorage.removeItem("jwt_user");
            // Let MainController handle the redirect
          }
          return $q.reject(rejection);
        }
      };
    }])
    .controller("MainController", MainController);

  MainController.$inject = ["$http", "$q", "$window", "$timeout"];

  function MainController($http, $q, $window, $timeout) {
    var vm = this;
    var messageToken = 0;
    var settingsTimer = null;

    // ── Auth state ────────────────────────────────────────────────────────────
    vm.isLoggedIn = false;
    vm.currentUser = {};
    vm.loginForm = { username: "", password: "" };
    vm.loginError = "";
    vm.loginLoading = false;

    // ── Navigation ────────────────────────────────────────────────────────────
    vm.section = "dashboard";

    // ── Sidebar state ─────────────────────────────────────────────────────────
    vm.sidebarCollapsed = false;
    vm.sidebarMobileOpen = false;
    vm.today = new Date();

    // ── Global state ──────────────────────────────────────────────────────────
    vm.loading = false;
    vm.darkMode = false;
    vm.message = { type: "", text: "" };
    vm.importPayload = "";

    // ── Products ──────────────────────────────────────────────────────────────
    vm.products = [];
    vm.searchText = "";
    vm.stockFilter = "all";
    vm.editingProductId = null;
    vm.productForm = resetProductForm();
    vm.restockForm = { productId: null, qty: null };
    vm.lowStockProducts = [];
    vm.lowStockExpanded = true;

    // ── Sales ─────────────────────────────────────────────────────────────────
    vm.salesData = [];
    vm.salesTotal = 0;
    vm.salesPage = 1;
    vm.salesPageSize = 20;
    vm.salesTotalPages = 1;
    vm.salesFrom = "";
    vm.salesTo = "";
    vm.salesSummary = { orders: 0, items: 0, grossRevenue: 0, discountTotal: 0, taxableRevenue: 0, gstCollected: 0, revenue: 0 };
    vm.monthlyRevenue = 0;
    vm.saleForm = resetSaleForm();
    vm.selectedInvoice = null;
    vm.returnModal = { show: false, sale: {}, qty: null, reason: "" };

    // ── Customers ─────────────────────────────────────────────────────────────
    vm.customers = [];
    vm.topCustomers = [];
    vm.customerSearch = "";
    vm.editingCustomerId = null;
    vm.customerForm = resetCustomerForm();
    vm.custHistModal = { show: false, customer: {}, history: [] };

    // ── Suppliers ─────────────────────────────────────────────────────────────
    vm.suppliers = [];
    vm.editingSupplierId = null;
    vm.supplierForm = resetSupplierForm();

    // ── Purchase Orders ───────────────────────────────────────────────────────
    vm.poData = [];
    vm.poTotal = 0;
    vm.poPage = 1;
    vm.poTotalPages = 1;
    vm.poForm = { supplierId: null, productId: null, qty: null, unitCost: null };

    // ── Returns ───────────────────────────────────────────────────────────────
    vm.returnsData = [];
    vm.returnsTotal = 0;
    vm.returnsPage = 1;
    vm.returnsTotalPages = 1;

    // ── Expenses ──────────────────────────────────────────────────────────────
    vm.expensesData = [];
    vm.expensesTotal = 0;
    vm.expensesPage = 1;
    vm.expensesTotalPages = 1;
    vm.expenseSummary = [];
    vm.expenseForm = resetExpenseForm();

    // ── Reports ───────────────────────────────────────────────────────────────
    vm.plReport = null;
    vm.plFrom = "";
    vm.plTo = "";
    vm.auditData = [];
    vm.auditPage = 1;
    vm.auditTotalPages = 1;
    vm.auditExpanded = false;
    vm.dailyRevenueChartObj = null;
    vm.topProductsChartObj = null;
    vm.dailyRevenueChartReportObj = null;
    vm.topProductsChartReportObj = null;

    // ── Settings ──────────────────────────────────────────────────────────────
    vm.settings = defaultSettings();

    // ── Users (admin) ─────────────────────────────────────────────────────────
    vm.usersList = [];
    vm.userForm = resetUserForm();

    // ── Backup (admin) ────────────────────────────────────────────────────────
    vm.backupsList = [];

    // ── Exposed functions ─────────────────────────────────────────────────────
    vm.login = login;
    vm.logout = logout;
    vm.goTo = goTo;
    vm.canAdmin = canAdmin;
    vm.canManager = canManager;
    vm.toggleDarkMode = toggleDarkMode;
    vm.toggleSidebar = toggleSidebar;
    vm.toggleMobileSidebar = toggleMobileSidebar;
    vm.closeMobileSidebar = closeMobileSidebar;
    vm.getGreeting = getGreeting;

    // Products
    vm.addOrUpdateProduct = addOrUpdateProduct;
    vm.startEditProduct = startEditProduct;
    vm.cancelEditProduct = cancelEditProduct;
    vm.deleteProduct = deleteProduct;
    vm.restockProduct = restockProduct;
    vm.quickRestock = quickRestock;
    vm.goToRestock = goToRestock;
    vm.getLowStockCount = getLowStockCount;
    vm.getFilteredProducts = getFilteredProducts;

    // Sales
    vm.recordSale = recordSale;
    vm.selectInvoice = selectInvoice;
    vm.printInvoice = printInvoice;
    vm.loadSales = loadSales;
    vm.nextPage = nextPage;
    vm.prevPage = prevPage;
    vm.applyDateFilter = applyDateFilter;
    vm.clearDateFilter = clearDateFilter;
    vm.getSelectedSaleProduct = getSelectedSaleProduct;
    vm.getSalePreview = getSalePreview;
    vm.openReturn = openReturn;
    vm.submitReturn = submitReturn;

    // Customers
    vm.addOrUpdateCustomer = addOrUpdateCustomer;
    vm.startEditCustomer = startEditCustomer;
    vm.cancelEditCustomer = cancelEditCustomer;
    vm.getFilteredCustomers = getFilteredCustomers;
    vm.viewCustomerHistory = viewCustomerHistory;

    // Suppliers
    vm.addOrUpdateSupplier = addOrUpdateSupplier;
    vm.startEditSupplier = startEditSupplier;
    vm.cancelEditSupplier = cancelEditSupplier;
    vm.deactivateSupplier = deactivateSupplier;

    // Purchase Orders
    vm.createPO = createPO;
    vm.receivePO = receivePO;
    vm.cancelPO = cancelPO;
    vm.poNextPage = poNextPage;
    vm.poPrevPage = poPrevPage;

    // Returns
    vm.returnsNextPage = returnsNextPage;
    vm.returnsPrevPage = returnsPrevPage;

    // Expenses
    vm.addExpense = addExpense;
    vm.deleteExpense = deleteExpense;
    vm.expensesNextPage = expensesNextPage;
    vm.expensesPrevPage = expensesPrevPage;

    // Reports
    vm.loadProfitLoss = loadProfitLoss;
    vm.clearPLFilter = clearPLFilter;
    vm.loadAudit = loadAudit;
    vm.auditNextPage = auditNextPage;
    vm.auditPrevPage = auditPrevPage;

    // Settings
    vm.updateSettings = updateSettings;
    vm.loadSampleData = loadSampleData;
    vm.exportData = exportData;
    vm.importData = importData;
    vm.clearAllData = clearAllData;

    // Users
    vm.registerUser = registerUser;
    vm.toggleUserStatus = toggleUserStatus;

    // Backup
    vm.createBackup = createBackup;
    vm.loadBackups = loadBackups;
    vm.downloadBackup = downloadBackup;

    // Formatters
    vm.formatInr = formatInr;
    vm.formatDateTime = formatDateTime;
    vm.formatDate = formatDate;
    vm.formatBytes = formatBytes;

    // ── Initialization ────────────────────────────────────────────────────────

    // Restore dark mode
    if ($window.localStorage.getItem("darkMode") === "true") {
      vm.darkMode = true;
      document.documentElement.setAttribute("data-theme", "dark");
    }

    // Try restoring session from localStorage
    var savedToken = $window.localStorage.getItem("jwt_token");
    var savedUser = $window.localStorage.getItem("jwt_user");
    if (savedToken && savedUser) {
      try {
        vm.currentUser = JSON.parse(savedUser);
        vm.isLoggedIn = true;
        $timeout(function () { loadState(); }, 0);
      } catch (e) {
        $window.localStorage.removeItem("jwt_token");
        $window.localStorage.removeItem("jwt_user");
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── AUTH ─────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function login() {
      vm.loginError = "";
      var username = (vm.loginForm.username || "").trim();
      var password = (vm.loginForm.password || "").trim();
      if (!username || !password) {
        vm.loginError = "Username and password are required.";
        return;
      }
      vm.loginLoading = true;
      $http.post("/api/auth/login", { username: username, password: password })
        .then(function (res) {
          var data = res.data || {};
          $window.localStorage.setItem("jwt_token", data.token);
          $window.localStorage.setItem("jwt_user", JSON.stringify(data.user));
          vm.currentUser = data.user;
          vm.isLoggedIn = true;
          vm.loginForm = { username: "", password: "" };
          loadState();
        })
        .catch(function (err) {
          vm.loginError = (err && err.data && err.data.error) ? err.data.error : "Login failed. Please try again.";
        })
        .finally(function () { vm.loginLoading = false; });
    }

    function logout() {
      $http.post("/api/auth/logout", {}).catch(angular.noop);
      $window.localStorage.removeItem("jwt_token");
      $window.localStorage.removeItem("jwt_user");
      vm.isLoggedIn = false;
      vm.currentUser = {};
      vm.section = "dashboard";
      // Reset all state
      vm.products = [];
      vm.salesData = [];
      vm.customers = [];
      vm.suppliers = [];
      vm.poData = [];
      vm.returnsData = [];
      vm.expensesData = [];
    }

    function canAdmin() {
      return vm.currentUser && vm.currentUser.role === "admin";
    }

    function canManager() {
      return vm.currentUser && (vm.currentUser.role === "admin" || vm.currentUser.role === "manager");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── NAVIGATION ───────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function goTo(section) {
      vm.section = section;
      vm.sidebarMobileOpen = false;
      clearMessage();

      switch (section) {
        case "dashboard":
          $timeout(function () { loadReports("dashboard"); }, 100);
          break;
        case "inventory":
          // already loaded
          break;
        case "sales":
          loadSales(1);
          break;
        case "customers":
          loadCustomers();
          loadTopCustomers();
          break;
        case "suppliers":
          loadSuppliers();
          break;
        case "purchaseOrders":
          loadPO(1);
          break;
        case "returns":
          loadReturns(1);
          break;
        case "expenses":
          loadExpenses(1);
          loadExpenseSummary();
          break;
        case "reports":
          loadAudit(1);
          $timeout(function () { loadReports("report"); }, 100);
          break;
        case "users":
          loadUsers();
          break;
        case "backup":
          loadBackups();
          break;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── INITIAL DATA LOAD ─────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadState() {
      vm.loading = true;
      $q.all([
        $http.get("/api/settings"),
        $http.get("/api/products"),
        $http.get("/api/sales/summary"),
        $http.get("/api/customers"),
        $http.get("/api/suppliers"),
        $http.get("/api/reports/monthly-revenue")
      ])
        .then(function (results) {
          vm.settings = normalizeSettings(results[0].data || {});
          vm.products = Array.isArray(results[1].data) ? results[1].data : [];
          vm.salesSummary = results[2].data || vm.salesSummary;
          vm.customers = Array.isArray(results[3].data) ? results[3].data : [];
          vm.suppliers = Array.isArray(results[4].data) ? results[4].data : [];
          vm.monthlyRevenue = (results[5].data && results[5].data.revenue) ? results[5].data.revenue : 0;
          vm.saleForm = resetSaleForm();
          return loadSales(1);
        })
        .then(function () {
          loadLowStock();
          $timeout(function () { loadReports("dashboard"); }, 100);
        })
        .catch(function (err) {
          if (err && err.status === 401) {
            logout();
          } else {
            showError("Failed to load data from server.");
          }
        })
        .finally(function () { vm.loading = false; });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── PRODUCTS ─────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function addOrUpdateProduct() {
      clearMessage();
      var payload = {
        name: safeText(vm.productForm.name),
        category: safeText(vm.productForm.category),
        unit: safeText(vm.productForm.unit),
        unitPrice: Number(vm.productForm.unitPrice),
        stockQty: toInt(vm.productForm.stockQty),
        costPrice: Number(vm.productForm.costPrice || 0),
        supplierId: toInt(vm.productForm.supplierId) || null
      };

      if (!payload.name || !payload.category || !payload.unit) {
        return showError("Name, category, and unit are required.");
      }
      if (Number.isNaN(payload.unitPrice) || payload.unitPrice < 0) {
        return showError("Unit price must be a valid non-negative number.");
      }
      if (Number.isNaN(payload.stockQty) || payload.stockQty < 0) {
        return showError("Stock quantity must be a valid non-negative number.");
      }

      vm.loading = true;
      if (vm.editingProductId) {
        $http.put("/api/products/" + vm.editingProductId, payload)
          .then(function () {
            var idx = vm.products.findIndex(function (p) { return p.id === vm.editingProductId; });
            if (idx !== -1) Object.assign(vm.products[idx], payload);
            cancelEditProduct();
            showSuccess("Product updated.");
            loadLowStock();
          })
          .catch(function (err) { showError(getError(err, "Unable to update product.")); })
          .finally(function () { vm.loading = false; });
      } else {
        $http.post("/api/products", payload)
          .then(function (res) {
            vm.products.push(res.data);
            vm.productForm = resetProductForm();
            showSuccess("Product added.");
          })
          .catch(function (err) { showError(getError(err, "Unable to add product.")); })
          .finally(function () { vm.loading = false; });
      }
    }

    function startEditProduct(product) {
      vm.editingProductId = product.id;
      vm.productForm = {
        name: product.name,
        category: product.category,
        unit: product.unit,
        unitPrice: product.unitPrice,
        stockQty: product.stockQty,
        costPrice: product.costPrice || 0,
        supplierId: product.supplierId || ""
      };
      $window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function cancelEditProduct() {
      vm.editingProductId = null;
      vm.productForm = resetProductForm();
    }

    function deleteProduct(product) {
      if (!$window.confirm('Delete "' + product.name + '"? This cannot be undone.')) return;
      vm.loading = true;
      $http.delete("/api/products/" + product.id)
        .then(function () {
          vm.products = vm.products.filter(function (p) { return p.id !== product.id; });
          showSuccess("Product deleted.");
          loadLowStock();
        })
        .catch(function (err) { showError(getError(err, "Cannot delete product.")); })
        .finally(function () { vm.loading = false; });
    }

    function restockProduct() {
      clearMessage();
      var productId = toInt(vm.restockForm.productId);
      var qty = toInt(vm.restockForm.qty);
      if (!productId || qty <= 0 || Number.isNaN(qty)) {
        return showError("Select a product and enter a quantity greater than zero.");
      }
      vm.loading = true;
      $http.put("/api/products/" + productId + "/stock", { delta: qty })
        .then(function (res) {
          updateProductStock(productId, res.data.stockQty);
          vm.restockForm = { productId: null, qty: null };
          showSuccess("Stock updated.");
          loadLowStock();
        })
        .catch(function (err) { showError(getError(err, "Unable to update stock.")); })
        .finally(function () { vm.loading = false; });
    }

    function quickRestock(productId) {
      $http.put("/api/products/" + productId + "/stock", { delta: 1 })
        .then(function (res) {
          updateProductStock(productId, res.data.stockQty);
          showSuccess("Stock increased by 1.");
          loadLowStock();
        })
        .catch(function () { showError("Unable to update stock."); });
    }

    function goToRestock(product) {
      vm.restockForm = { productId: product.id, qty: null };
      goTo("inventory");
    }

    function loadLowStock() {
      $http.get("/api/products/low-stock")
        .then(function (res) { vm.lowStockProducts = Array.isArray(res.data) ? res.data : []; });
    }

    function getLowStockCount() {
      return vm.products.filter(function (p) {
        return p.stockQty <= vm.settings.lowStockThreshold;
      }).length;
    }

    function getFilteredProducts() {
      var q = safeText(vm.searchText).toLowerCase();
      return vm.products
        .filter(function (p) {
          var matchSearch = !q ||
            p.name.toLowerCase().indexOf(q) !== -1 ||
            p.category.toLowerCase().indexOf(q) !== -1;
          var isLow = p.stockQty <= vm.settings.lowStockThreshold;
          var matchFilter = vm.stockFilter === "all" ||
            (vm.stockFilter === "low" && isLow) ||
            (vm.stockFilter === "in" && p.stockQty > 0);
          return matchSearch && matchFilter;
        })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── SALES ─────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadSales(page, from, to) {
      var p = page || vm.salesPage;
      var f = from !== undefined ? from : vm.salesFrom;
      var t = to !== undefined ? to : vm.salesTo;
      var params = { page: p, pageSize: vm.salesPageSize };
      if (f) params.from = f;
      if (t) params.to = t;

      return $http.get("/api/sales", { params: params })
        .then(function (res) {
          var data = res.data || {};
          vm.salesData = Array.isArray(data.data) ? data.data : [];
          vm.salesTotal = data.total || 0;
          vm.salesPage = data.page || 1;
          vm.salesTotalPages = data.totalPages || 1;
        });
    }

    function recordSale() {
      clearMessage();
      var customerId = toInt(vm.saleForm.customerId) || null;
      var payload = {
        productId: toInt(vm.saleForm.productId),
        qty: toInt(vm.saleForm.qty),
        discount: Number(vm.saleForm.discount || 0),
        gstPercent: normalizePercent(vm.saleForm.gstPercent),
        paymentMode: safeText(vm.saleForm.paymentMode) || "Cash",
        customerName: safeText(vm.saleForm.customerName),
        customerId: customerId
      };

      if (!payload.productId || payload.qty <= 0) {
        return showError("Select a product and enter quantity greater than zero.");
      }
      if (Number.isNaN(payload.discount) || payload.discount < 0) {
        return showError("Discount must be a valid non-negative number.");
      }

      vm.loading = true;
      $http.post("/api/sales", payload)
        .then(function (res) {
          var sale = res.data.sale;
          var product = res.data.product;
          if (product) updateProductStock(product.id, product.stockQty);
          vm.saleForm = resetSaleForm();
          vm.selectedInvoice = sale || null;
          showSuccess("Sale recorded. Invoice " + (sale ? sale.invoiceNo : "") + " generated.");
          return $q.all([loadSales(1), $http.get("/api/sales/summary"), $http.get("/api/reports/monthly-revenue")]);
        })
        .then(function (results) {
          if (results && results[1]) vm.salesSummary = results[1].data || vm.salesSummary;
          if (results && results[2]) vm.monthlyRevenue = (results[2].data && results[2].data.revenue) || 0;
          loadLowStock();
        })
        .catch(function (err) { showError(getError(err, "Unable to record sale.")); })
        .finally(function () { vm.loading = false; });
    }

    function selectInvoice(saleId) {
      var id = toInt(saleId);
      vm.selectedInvoice = vm.salesData.find(function (s) { return s.id === id; }) || null;
    }

    function printInvoice(saleId) {
      if (saleId) selectInvoice(saleId);
      if (!vm.selectedInvoice) return;
      $timeout(function () { $window.print(); }, 80);
    }

    function nextPage()  { if (vm.salesPage < vm.salesTotalPages) loadSales(vm.salesPage + 1); }
    function prevPage()  { if (vm.salesPage > 1) loadSales(vm.salesPage - 1); }

    function applyDateFilter() {
      loadSales(1, vm.salesFrom, vm.salesTo);
      $http.get("/api/sales/summary", { params: { from: vm.salesFrom, to: vm.salesTo } })
        .then(function (res) { vm.salesSummary = res.data || vm.salesSummary; });
    }

    function clearDateFilter() {
      vm.salesFrom = "";
      vm.salesTo = "";
      loadSales(1, "", "");
      $http.get("/api/sales/summary").then(function (res) { vm.salesSummary = res.data || vm.salesSummary; });
    }

    function getSelectedSaleProduct() {
      var id = toInt(vm.saleForm.productId);
      return id ? vm.products.find(function (p) { return p.id === id; }) : null;
    }

    function getSalePreview() {
      var product = getSelectedSaleProduct();
      var qty = toInt(vm.saleForm.qty);
      var discount = Number(vm.saleForm.discount || 0);
      var gstPercent = normalizePercent(vm.saleForm.gstPercent);
      if (!product || !qty || qty <= 0 || Number.isNaN(discount) || discount < 0) {
        return { grossTotal: 0, taxableTotal: 0, gstAmount: 0, netTotal: 0 };
      }
      var grossTotal = roundMoney(product.unitPrice * qty);
      var safeDiscount = discount > grossTotal ? grossTotal : discount;
      var taxableTotal = roundMoney(grossTotal - safeDiscount);
      var gstAmount = roundMoney(taxableTotal * gstPercent / 100);
      return { grossTotal: grossTotal, taxableTotal: taxableTotal, gstAmount: gstAmount, netTotal: roundMoney(taxableTotal + gstAmount) };
    }

    function openReturn(sale) {
      vm.returnModal = { show: true, sale: sale, qty: 1, reason: "" };
    }

    function submitReturn() {
      var sale = vm.returnModal.sale;
      var qty = toInt(vm.returnModal.qty);
      var reason = safeText(vm.returnModal.reason);
      if (!qty || qty <= 0 || qty > sale.qty) {
        return showError("Return quantity must be between 1 and " + sale.qty + ".");
      }
      if (!reason) return showError("Reason is required.");

      vm.loading = true;
      $http.post("/api/returns", { saleId: sale.id, qty: qty, reason: reason })
        .then(function (res) {
          vm.returnModal.show = false;
          showSuccess("Return processed. Refund: " + formatInr(res.data.refundAmount));
          loadSales(vm.salesPage);
          // Update local stock
          var product = vm.products.find(function (p) { return p.id === res.data.productId; });
          if (product) product.stockQty += qty;
          loadLowStock();
        })
        .catch(function (err) { showError(getError(err, "Unable to process return.")); })
        .finally(function () { vm.loading = false; });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── CUSTOMERS ────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadCustomers() {
      return $http.get("/api/customers")
        .then(function (res) { vm.customers = Array.isArray(res.data) ? res.data : []; });
    }

    function loadTopCustomers() {
      $http.get("/api/customers/top")
        .then(function (res) { vm.topCustomers = Array.isArray(res.data) ? res.data : []; });
    }

    function addOrUpdateCustomer() {
      clearMessage();
      var payload = {
        name: safeText(vm.customerForm.name),
        phone: safeText(vm.customerForm.phone) || null,
        email: safeText(vm.customerForm.email) || null,
        address: safeText(vm.customerForm.address) || null
      };
      if (!payload.name) return showError("Customer name is required.");

      vm.loading = true;
      if (vm.editingCustomerId) {
        $http.put("/api/customers/" + vm.editingCustomerId, payload)
          .then(function () {
            var idx = vm.customers.findIndex(function (c) { return c.id === vm.editingCustomerId; });
            if (idx !== -1) Object.assign(vm.customers[idx], payload);
            cancelEditCustomer();
            showSuccess("Customer updated.");
          })
          .catch(function (err) { showError(getError(err, "Unable to update customer.")); })
          .finally(function () { vm.loading = false; });
      } else {
        $http.post("/api/customers", payload)
          .then(function (res) {
            vm.customers.push(res.data);
            vm.customerForm = resetCustomerForm();
            showSuccess("Customer registered.");
          })
          .catch(function (err) { showError(getError(err, "Unable to add customer.")); })
          .finally(function () { vm.loading = false; });
      }
    }

    function startEditCustomer(customer) {
      vm.editingCustomerId = customer.id;
      vm.customerForm = {
        name: customer.name,
        phone: customer.phone || "",
        email: customer.email || "",
        address: customer.address || ""
      };
      $window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function cancelEditCustomer() {
      vm.editingCustomerId = null;
      vm.customerForm = resetCustomerForm();
    }

    function getFilteredCustomers() {
      var q = safeText(vm.customerSearch).toLowerCase();
      if (!q) return vm.customers;
      return vm.customers.filter(function (c) {
        return c.name.toLowerCase().indexOf(q) !== -1 ||
          (c.phone && c.phone.indexOf(q) !== -1);
      });
    }

    function viewCustomerHistory(customer) {
      vm.custHistModal = { show: true, customer: customer, history: [] };
      $http.get("/api/customers/" + customer.id + "/history")
        .then(function (res) { vm.custHistModal.history = Array.isArray(res.data) ? res.data : []; })
        .catch(function () { showError("Unable to load purchase history."); });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── SUPPLIERS ────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadSuppliers() {
      return $http.get("/api/suppliers")
        .then(function (res) { vm.suppliers = Array.isArray(res.data) ? res.data : []; });
    }

    function addOrUpdateSupplier() {
      clearMessage();
      var payload = {
        name: safeText(vm.supplierForm.name),
        contactPerson: safeText(vm.supplierForm.contactPerson) || "",
        phone: safeText(vm.supplierForm.phone) || "",
        email: safeText(vm.supplierForm.email) || "",
        address: safeText(vm.supplierForm.address) || "",
        gstNumber: safeText(vm.supplierForm.gstNumber) || ""
      };
      if (!payload.name) return showError("Supplier name is required.");

      vm.loading = true;
      if (vm.editingSupplierId) {
        $http.put("/api/suppliers/" + vm.editingSupplierId, payload)
          .then(function () {
            var idx = vm.suppliers.findIndex(function (s) { return s.id === vm.editingSupplierId; });
            if (idx !== -1) Object.assign(vm.suppliers[idx], payload);
            cancelEditSupplier();
            showSuccess("Supplier updated.");
          })
          .catch(function (err) { showError(getError(err, "Unable to update supplier.")); })
          .finally(function () { vm.loading = false; });
      } else {
        $http.post("/api/suppliers", payload)
          .then(function (res) {
            vm.suppliers.push(res.data);
            vm.supplierForm = resetSupplierForm();
            showSuccess("Supplier added.");
          })
          .catch(function (err) { showError(getError(err, "Unable to add supplier.")); })
          .finally(function () { vm.loading = false; });
      }
    }

    function startEditSupplier(supplier) {
      vm.editingSupplierId = supplier.id;
      vm.supplierForm = {
        name: supplier.name,
        contactPerson: supplier.contactPerson || "",
        phone: supplier.phone || "",
        email: supplier.email || "",
        address: supplier.address || "",
        gstNumber: supplier.gstNumber || ""
      };
      $window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function cancelEditSupplier() {
      vm.editingSupplierId = null;
      vm.supplierForm = resetSupplierForm();
    }

    function deactivateSupplier(supplier) {
      if (!$window.confirm('Deactivate supplier "' + supplier.name + '"?')) return;
      vm.loading = true;
      $http.delete("/api/suppliers/" + supplier.id)
        .then(function () {
          var idx = vm.suppliers.findIndex(function (s) { return s.id === supplier.id; });
          if (idx !== -1) vm.suppliers[idx].isActive = 0;
          showSuccess("Supplier deactivated.");
        })
        .catch(function (err) { showError(getError(err, "Unable to deactivate supplier.")); })
        .finally(function () { vm.loading = false; });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── PURCHASE ORDERS ──────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadPO(page) {
      var p = page || vm.poPage;
      return $http.get("/api/purchase-orders", { params: { page: p, pageSize: 20 } })
        .then(function (res) {
          var data = res.data || {};
          vm.poData = Array.isArray(data.data) ? data.data : [];
          vm.poTotal = data.total || 0;
          vm.poPage = data.page || 1;
          vm.poTotalPages = data.totalPages || 1;
        });
    }

    function createPO() {
      clearMessage();
      var payload = {
        supplierId: toInt(vm.poForm.supplierId),
        productId: toInt(vm.poForm.productId),
        qty: toInt(vm.poForm.qty),
        unitCost: Number(vm.poForm.unitCost)
      };
      if (!payload.supplierId) return showError("Supplier is required.");
      if (!payload.productId) return showError("Product is required.");
      if (!payload.qty || payload.qty <= 0) return showError("Quantity must be greater than zero.");
      if (Number.isNaN(payload.unitCost) || payload.unitCost < 0) return showError("Unit cost must be a valid number.");

      vm.loading = true;
      $http.post("/api/purchase-orders", payload)
        .then(function (res) {
          vm.poData.unshift(res.data);
          vm.poForm = { supplierId: null, productId: null, qty: null, unitCost: null };
          showSuccess("Purchase order " + res.data.poNumber + " created.");
        })
        .catch(function (err) { showError(getError(err, "Unable to create purchase order.")); })
        .finally(function () { vm.loading = false; });
    }

    function receivePO(po) {
      if (!$window.confirm("Mark PO " + po.poNumber + " as received? This will add " + po.qty + " units to stock.")) return;
      vm.loading = true;
      $http.put("/api/purchase-orders/" + po.id + "/receive")
        .then(function () {
          po.status = "received";
          po.receivedAt = new Date().toISOString();
          showSuccess("PO received. Stock updated.");
          // Refresh product stock
          var product = vm.products.find(function (p) { return p.id === po.productId; });
          if (product) product.stockQty += po.qty;
          loadLowStock();
        })
        .catch(function (err) { showError(getError(err, "Unable to receive PO.")); })
        .finally(function () { vm.loading = false; });
    }

    function cancelPO(po) {
      if (!$window.confirm("Cancel PO " + po.poNumber + "?")) return;
      vm.loading = true;
      $http.put("/api/purchase-orders/" + po.id + "/cancel")
        .then(function () {
          po.status = "cancelled";
          showSuccess("PO cancelled.");
        })
        .catch(function (err) { showError(getError(err, "Unable to cancel PO.")); })
        .finally(function () { vm.loading = false; });
    }

    function poNextPage()  { if (vm.poPage < vm.poTotalPages) loadPO(vm.poPage + 1); }
    function poPrevPage()  { if (vm.poPage > 1) loadPO(vm.poPage - 1); }

    // ══════════════════════════════════════════════════════════════════════════
    // ── RETURNS ──────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadReturns(page) {
      var p = page || vm.returnsPage;
      return $http.get("/api/returns", { params: { page: p, pageSize: 20 } })
        .then(function (res) {
          var data = res.data || {};
          vm.returnsData = Array.isArray(data.data) ? data.data : [];
          vm.returnsTotal = data.total || 0;
          vm.returnsPage = data.page || 1;
          vm.returnsTotalPages = data.totalPages || 1;
        });
    }

    function returnsNextPage()  { if (vm.returnsPage < vm.returnsTotalPages) loadReturns(vm.returnsPage + 1); }
    function returnsPrevPage()  { if (vm.returnsPage > 1) loadReturns(vm.returnsPage - 1); }

    // ══════════════════════════════════════════════════════════════════════════
    // ── EXPENSES ─────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadExpenses(page) {
      var p = page || vm.expensesPage;
      return $http.get("/api/expenses", { params: { page: p, pageSize: 20 } })
        .then(function (res) {
          var data = res.data || {};
          vm.expensesData = Array.isArray(data.data) ? data.data : [];
          vm.expensesTotal = data.total || 0;
          vm.expensesPage = data.page || 1;
          vm.expensesTotalPages = data.totalPages || 1;
        });
    }

    function loadExpenseSummary() {
      $http.get("/api/expenses/summary")
        .then(function (res) { vm.expenseSummary = Array.isArray(res.data) ? res.data : []; });
    }

    function addExpense() {
      clearMessage();
      var payload = {
        category: safeText(vm.expenseForm.category),
        amount: Number(vm.expenseForm.amount),
        expenseDate: vm.expenseForm.expenseDate || new Date().toISOString().split("T")[0],
        paymentMode: vm.expenseForm.paymentMode || "Cash",
        description: safeText(vm.expenseForm.description) || ""
      };
      if (!payload.category) return showError("Category is required.");
      if (Number.isNaN(payload.amount) || payload.amount <= 0) return showError("Amount must be greater than 0.");

      vm.loading = true;
      $http.post("/api/expenses", payload)
        .then(function (res) {
          vm.expensesData.unshift(res.data);
          vm.expensesTotal++;
          vm.expenseForm = resetExpenseForm();
          showSuccess("Expense recorded.");
          loadExpenseSummary();
        })
        .catch(function (err) { showError(getError(err, "Unable to add expense.")); })
        .finally(function () { vm.loading = false; });
    }

    function deleteExpense(expense) {
      if (!$window.confirm("Delete this expense record?")) return;
      vm.loading = true;
      $http.delete("/api/expenses/" + expense.id)
        .then(function () {
          vm.expensesData = vm.expensesData.filter(function (e) { return e.id !== expense.id; });
          vm.expensesTotal--;
          showSuccess("Expense deleted.");
          loadExpenseSummary();
        })
        .catch(function (err) { showError(getError(err, "Unable to delete expense.")); })
        .finally(function () { vm.loading = false; });
    }

    function expensesNextPage()  { if (vm.expensesPage < vm.expensesTotalPages) loadExpenses(vm.expensesPage + 1); }
    function expensesPrevPage()  { if (vm.expensesPage > 1) loadExpenses(vm.expensesPage - 1); }

    // ══════════════════════════════════════════════════════════════════════════
    // ── REPORTS ──────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadProfitLoss() {
      var params = {};
      if (vm.plFrom) params.from = vm.plFrom;
      if (vm.plTo) params.to = vm.plTo;
      $http.get("/api/reports/profit-loss", { params: params })
        .then(function (res) { vm.plReport = res.data || null; })
        .catch(function () { showError("Unable to load P&L report."); });
    }

    function clearPLFilter() {
      vm.plFrom = "";
      vm.plTo = "";
      loadProfitLoss();
    }

    function loadReports(context) {
      $q.all([
        $http.get("/api/reports/daily-revenue"),
        $http.get("/api/reports/top-products")
      ]).then(function (results) {
        if (context === "dashboard") {
          renderChart("dailyRevenueChart", "line", buildDailyData(results[0].data || []), "vm.dailyRevenueChartObj");
          renderChart("topProductsChart", "doughnut", buildTopData(results[1].data || []), "vm.topProductsChartObj");
        } else {
          renderChart("dailyRevenueChartReport", "line", buildDailyData(results[0].data || []), "vm.dailyRevenueChartReportObj");
          renderChart("topProductsChartReport", "doughnut", buildTopData(results[1].data || []), "vm.topProductsChartReportObj");
        }
      });
    }

    function renderChart(canvasId, type, data, chartVar) {
      var canvas = document.getElementById(canvasId);
      if (!canvas || !$window.Chart) return;
      var existing = vm[chartVar.replace("vm.", "")];
      if (existing) { existing.destroy(); }
      var chartInst = new $window.Chart(canvas, {
        type: type,
        data: data,
        options: type === "line"
          ? { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
          : { responsive: true, plugins: { legend: { position: "bottom" } } }
      });
      vm[chartVar.replace("vm.", "")] = chartInst;
    }

    function buildDailyData(rows) {
      return {
        labels: rows.map(function (r) { return r.day; }),
        datasets: [{
          label: "Revenue (₹)",
          data: rows.map(function (r) { return r.revenue; }),
          borderColor: "#16a34a",
          backgroundColor: "rgba(22, 163, 74, 0.08)",
          tension: 0.4,
          fill: true,
          pointBackgroundColor: "#16a34a"
        }]
      };
    }

    function buildTopData(rows) {
      var colors = ["#16a34a","#f59e0b","#059669","#e11d48","#4d7c5f","#15803d","#b45309","#22c55e","#fbbf24","#052e16"];
      return {
        labels: rows.map(function (r) { return r.name; }),
        datasets: [{
          data: rows.map(function (r) { return r.revenue; }),
          backgroundColor: colors.slice(0, rows.length)
        }]
      };
    }

    function loadAudit(page) {
      var p = page || vm.auditPage;
      $http.get("/api/audit", { params: { page: p, pageSize: 20 } })
        .then(function (res) {
          var data = res.data || {};
          vm.auditData = Array.isArray(data.data) ? data.data : [];
          vm.auditPage = data.page || 1;
          vm.auditTotalPages = data.totalPages || 1;
        });
    }

    function auditNextPage() { if (vm.auditPage < vm.auditTotalPages) loadAudit(vm.auditPage + 1); }
    function auditPrevPage() { if (vm.auditPage > 1) loadAudit(vm.auditPage - 1); }

    // ══════════════════════════════════════════════════════════════════════════
    // ── SETTINGS ─────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function updateSettings() {
      if (settingsTimer) $timeout.cancel(settingsTimer);
      settingsTimer = $timeout(function () {
        var payload = normalizeSettings(vm.settings);
        vm.settings = payload;
        vm.saleForm.gstPercent = payload.gstPercent;
        $http.put("/api/settings", payload)
          .catch(function () { showError("Unable to save settings."); });
      }, 350);
    }

    function loadSampleData() {
      if (!$window.confirm("This will overwrite all existing data. Continue?")) return;
      vm.loading = true;
      $http.post("/api/seed", {}, { headers: { "x-confirm": "yes" } })
        .then(function () { showSuccess("Sample data loaded."); loadState(); })
        .catch(function () { showError("Unable to load sample data."); })
        .finally(function () { vm.loading = false; });
    }

    function exportData() {
      $http.get("/api/export")
        .then(function (res) {
          var blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
          var url = $window.URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "grocery-backup-" + new Date().toISOString().split("T")[0] + ".json";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          $window.URL.revokeObjectURL(url);
          showSuccess("Data exported successfully.");
        })
        .catch(function () { showError("Unable to export data."); });
    }

    function importData() {
      clearMessage();
      if (!safeText(vm.importPayload)) return showError("Paste JSON data first.");
      try {
        var parsed = JSON.parse(vm.importPayload);
        vm.loading = true;
        $http.post("/api/import", parsed, { headers: { "x-confirm": "yes" } })
          .then(function () {
            vm.importPayload = "";
            showSuccess("Data imported successfully.");
            loadState();
          })
          .catch(function () { showError("Import failed. Check server logs."); })
          .finally(function () { vm.loading = false; });
      } catch (e) {
        showError("Invalid JSON. Please verify the backup format.");
      }
    }

    function clearAllData() {
      if (!$window.confirm("Delete ALL products, sales, and records? This cannot be undone.")) return;
      vm.loading = true;
      $http.delete("/api/clear", { headers: { "x-confirm": "yes" } })
        .then(function () { showSuccess("All data cleared."); loadState(); })
        .catch(function () { showError("Unable to clear data."); })
        .finally(function () { vm.loading = false; });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── USERS ────────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadUsers() {
      $http.get("/api/users")
        .then(function (res) { vm.usersList = Array.isArray(res.data) ? res.data : []; })
        .catch(function () { showError("Unable to load users."); });
    }

    function registerUser() {
      clearMessage();
      var payload = {
        username: safeText(vm.userForm.username),
        fullName: safeText(vm.userForm.fullName),
        email: safeText(vm.userForm.email),
        password: (vm.userForm.password || "").trim(),
        role: vm.userForm.role || "cashier"
      };
      if (!payload.username || !payload.fullName || !payload.email || !payload.password) {
        return showError("All fields are required.");
      }
      if (payload.password.length < 6) {
        return showError("Password must be at least 6 characters.");
      }

      vm.loading = true;
      $http.post("/api/auth/register", payload)
        .then(function (res) {
          vm.usersList.push(Object.assign(res.data, { isActive: 1, lastLogin: null }));
          vm.userForm = resetUserForm();
          showSuccess("User registered: " + res.data.username);
        })
        .catch(function (err) { showError(getError(err, "Unable to register user.")); })
        .finally(function () { vm.loading = false; });
    }

    function toggleUserStatus(user) {
      var newStatus = user.isActive ? 0 : 1;
      var action = newStatus ? "activate" : "deactivate";
      if (!$window.confirm(action.charAt(0).toUpperCase() + action.slice(1) + " user " + user.username + "?")) return;

      vm.loading = true;
      $http.put("/api/users/" + user.id, { isActive: !!newStatus })
        .then(function () {
          user.isActive = newStatus;
          showSuccess("User " + action + "d.");
        })
        .catch(function (err) { showError(getError(err, "Unable to update user.")); })
        .finally(function () { vm.loading = false; });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── BACKUP ───────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function loadBackups() {
      $http.get("/api/backups")
        .then(function (res) { vm.backupsList = Array.isArray(res.data) ? res.data : []; })
        .catch(function () { showError("Unable to load backup list."); });
    }

    function createBackup() {
      vm.loading = true;
      $http.post("/api/backups")
        .then(function (res) {
          vm.backupsList.unshift(res.data);
          showSuccess("Backup created: " + res.data.filename);
        })
        .catch(function () { showError("Unable to create backup."); })
        .finally(function () { vm.loading = false; });
    }

    function downloadBackup(filename) {
      $window.open("/api/backups/" + filename, "_blank");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── DARK MODE ────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function toggleDarkMode() {
      vm.darkMode = !vm.darkMode;
      document.documentElement.setAttribute("data-theme", vm.darkMode ? "dark" : "light");
      $window.localStorage.setItem("darkMode", vm.darkMode ? "true" : "false");
    }

    function toggleSidebar() {
      vm.sidebarCollapsed = !vm.sidebarCollapsed;
    }

    function toggleMobileSidebar() {
      vm.sidebarMobileOpen = !vm.sidebarMobileOpen;
    }

    function closeMobileSidebar() {
      vm.sidebarMobileOpen = false;
    }

    function getGreeting() {
      var hour = new Date().getHours();
      if (hour < 12) return "Good morning";
      if (hour < 17) return "Good afternoon";
      return "Good evening";
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── HELPERS ──────────────────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    function updateProductStock(productId, stockQty) {
      var product = vm.products.find(function (p) { return p.id === productId; });
      if (product) product.stockQty = stockQty;
    }

    function normalizeSettings(source) {
      var s = source || {};
      return {
        storeName: safeText(s.storeName) || "My Grocery Store",
        storePhone: safeText(s.storePhone),
        storeAddress: safeText(s.storeAddress),
        gstPercent: normalizePercent(s.gstPercent),
        lowStockThreshold: normalizeThreshold(s.lowStockThreshold)
      };
    }

    function defaultSettings() {
      return { storeName: "My Grocery Store", storePhone: "", storeAddress: "", gstPercent: 5, lowStockThreshold: 5 };
    }

    function normalizeThreshold(v) { var p = toInt(v); return (!p || p < 1) ? 5 : p; }
    function normalizePercent(v) { var p = Number(v); if (Number.isNaN(p) || p < 0) return 0; if (p > 100) return 100; return roundMoney(p); }

    function showSuccess(text) { setMessage("success", text); }
    function showError(text)   { setMessage("error", text); }

    function getError(err, fallback) {
      return (err && err.data && err.data.error) ? err.data.error : fallback;
    }

    function setMessage(type, text) {
      messageToken += 1;
      var token = messageToken;
      vm.message.type = type;
      vm.message.text = text;
      $timeout(function () {
        if (token === messageToken) { vm.message.type = ""; vm.message.text = ""; }
      }, 4500);
    }

    function clearMessage() {
      messageToken += 1;
      vm.message.type = "";
      vm.message.text = "";
    }

    function resetProductForm()  { return { name: "", category: "", unit: "", unitPrice: null, stockQty: null, costPrice: null, supplierId: "" }; }
    function resetCustomerForm() { return { name: "", phone: "", email: "", address: "" }; }
    function resetSupplierForm() { return { name: "", contactPerson: "", phone: "", email: "", address: "", gstNumber: "" }; }
    function resetExpenseForm()  { return { category: "", amount: null, expenseDate: new Date().toISOString().split("T")[0], paymentMode: "Cash", description: "" }; }
    function resetUserForm()     { return { username: "", fullName: "", email: "", password: "", role: "cashier" }; }
    function resetSaleForm() {
      return { productId: null, qty: 1, discount: 0, gstPercent: vm.settings && vm.settings.gstPercent ? vm.settings.gstPercent : 5, customerName: "", customerId: "", paymentMode: "Cash" };
    }

    function safeText(v) { return (v || "").toString().trim(); }
    function toInt(v) { return parseInt(v, 10); }
    function roundMoney(v) { return Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100; }

    function formatInr(value) {
      return "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatDateTime(value) {
      var dt = new Date(value);
      if (Number.isNaN(dt.getTime())) return "-";
      return dt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function formatDate(value) {
      if (!value) return "-";
      var dt = new Date(value);
      if (Number.isNaN(dt.getTime())) return value;
      return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    }

    function formatBytes(bytes) {
      if (!bytes) return "0 B";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    }
  }

})();
