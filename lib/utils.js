'use strict';

var _ = require('lodash');
var async = require('async');
var Common = require('./common');

function UtilsController(node) {
  this.node = node;
  this.common = new Common({log: this.node.log});
}

UtilsController.prototype.estimateSmartFee = function(req, res) {
  var self = this;
  var nbBlocksS = req.query.nbBlocks || '2';
  var nbBlocks = nbBlocksS.split(',');
  var modeS = req.query.mode || 'conservative';
  var conservative = modeS.toLowerCase() !== 'economical';

  async.map(nbBlocks, function(n, next) {
    var num = parseInt(n);
    // Insight and Ravencoin JSON-RPC return ravencoin for this value (instead of satoshis).
    self.node.services.ravend.estimateSmartFee(num, conservative, function(err, fee) {
      if (err) {
        return next(err);
      }
      next(null, [num, fee]);
    });
  }, function(err, result) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    res.jsonp(_.zipObject(result));
  });

};

module.exports = UtilsController;
