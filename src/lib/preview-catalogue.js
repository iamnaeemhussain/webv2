// Read-only preview snapshot of the public Sheet1, retrieved 2026-11-17.
// The Worker never uses these values for checkout or fulfilment.
export const previewCatalogueDate = '2026-11-17';
const rows = [
  ['Trial Plan',220,'0.5 GB',1,false,349,37,'c9b922d6a687dc41955220eb30283c6e'],
  ['1 GB 7 Days',399,'1 GB',7,false,599,33,'ce820a6927dc6683ae068a4a0f0d6167'],
  ['3 GB 7 Days',899,'3 GB',7,false,1499,40,'7693d1a556606d1d75dd9b4514e21f41'],
  ['5 GB 15 Days',1499,'5 GB',15,false,2099,29,'a049c0fe065cf7a17e676f8ea93af85c'],
  ['10 GB 30 Days',1999,'10 GB',30,false,3499,43,'d06bbcd1383c83e78aacf30c611545fe'],
  ['15 GB 30 Days',2499,'15 GB',30,true,4999,50,'e299479f253a1a82968fd070df904313'],
  ['20 GB 30 Days',3499,'20 GB',30,true,6999,50,'af8d969ec557facbbeda2f7429b35613'],
  ['30 GB 30 Days',4999,'30 GB',30,true,9999,50,'a851993e90efd5cb6408d578cb349683'],
  ['Unlimited Data for 7 Days',3099,'Unlimited Data',7,false,6199,50,'c8bff43b761f6fa2687e9c56f1d1e6a6'],
  ['Unlimited Data for 15 Days',4499,'Unlimited Data',15,false,8999,50,'9da295046ca53b298db6c1660286a018'],
  ['Unlimited Data for 30 Days',7099,'Unlimited Data',30,true,14999,53,'8cd5dd1e81d789a5e8512759c36b4296'],
];
export const previewPlans = rows.map(([name,pricePkr,data,days,popular,actualPricePkr,discountPct,planId]) => ({
  name,pricePkr,data,days,popular,actualPricePkr,discountPct,planId,reloadable:true,
}));
