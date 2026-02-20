import * as errorHandler from './javascript/features/errorHandler.js';

console.log('All exports:', Object.keys(errorHandler));
console.log('ERROR_SEVERITY in exports:', 'ERROR_SEVERITY' in errorHandler);
if (errorHandler.ERROR_SEVERITY) {
  console.log('ERROR_SEVERITY value:', errorHandler.ERROR_SEVERITY);
}