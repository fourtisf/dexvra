'use strict';
// Moved to shared/security/ so the listing bot asks the SAME safety source the
// trade bot does — two copies of "is this a honeypot" would come to disagree.
module.exports = require('../shared/security/goplus');
