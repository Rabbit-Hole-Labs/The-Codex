import errorHandler from './javascript/features/errorHandler.js';

console.log('Default export keys:', Object.keys(errorHandler));
console.log('ERROR_SEVERITY in default export:', 'ERROR_SEVERITY' in errorHandler);
if (errorHandler.ERROR_SEVERITY) {
  console.log('ERROR_SEVERITY value:', errorHandler.ERROR_SEVERITY);
}