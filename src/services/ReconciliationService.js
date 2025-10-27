const VenueReconciliation = require('../models/VenueReconciliation');
const Store = require('../models/Store');

class ReconciliationService {
  /**
   * Calculate expected software fee for a venue on a given date
   */
  static async calculateExpectedSoftwareFee(storeId, gamingRevenue) {
    const store = await Store.findOne({ storeId }).lean();
    if (!store) {
      throw new Error(`Store ${storeId} not found`);
    }
    
    const feePercentage = store.feePercentage || 0;
    const expectedFee = (gamingRevenue * feePercentage) / 100;
    
    return {
      feePercentage,
      expectedFee,
      store
    };
  }

  /**
   * Create daily reconciliation record
   */
  static async createDailyReconciliation(storeId, reconciliationDate, venueGamingRevenue, submittedBy) {
    const { feePercentage, expectedFee, store } = await this.calculateExpectedSoftwareFee(storeId, venueGamingRevenue);
    
    const reconciliation = new VenueReconciliation({
      storeId,
      reconciliationDate: new Date(reconciliationDate),
      venueGamingRevenue,
      softwareFeePercentage: feePercentage,
      expectedSoftwareFee: expectedFee,
      submittedBy
    });
    
    return reconciliation.save();
  }

  /**
   * Update reconciliation with actual software fee received
   */
  static async updateActualSoftwareFee(reconciliationId, actualSoftwareFee, updatedBy) {
    const reconciliation = await VenueReconciliation.findById(reconciliationId);
    if (!reconciliation) {
      throw new Error('Reconciliation not found');
    }

    reconciliation.actualSoftwareFee = actualSoftwareFee;
    
    // If this makes it compliant, mark as approved
    if (reconciliation.calculateComplianceScore() >= 90) {
      reconciliation.reconciliationStatus = 'approved';
      reconciliation.approvedBy = updatedBy;
      reconciliation.approvedAt = new Date();
    }

    return reconciliation.save();
  }

  /**
   * Get venues that haven't submitted today's reconciliation
   */
  static async getMissingReconciliations(targetDate = new Date()) {
    const dateStart = new Date(targetDate);
    dateStart.setHours(0, 0, 0, 0);
    
    const dateEnd = new Date(targetDate);
    dateEnd.setHours(23, 59, 59, 999);
    
    // Get all active stores
    const activeStores = await Store.find({ status: 'active' }).select('storeId storeName').lean();
    
    // Get stores that already submitted reconciliation for this date
    const submittedStores = await VenueReconciliation.find({
      reconciliationDate: { $gte: dateStart, $lte: dateEnd }
    }).distinct('storeId');
    
    // Return stores that haven't submitted
    return activeStores.filter(store => !submittedStores.includes(store.storeId));
  }

  /**
   * Get reconciliation dashboard data for a venue
   */
  static async getVenueDashboard(storeId, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [stats, recentReconciliations, pendingCount] = await Promise.all([
      VenueReconciliation.getVenueComplianceStats(storeId, days),
      VenueReconciliation.find({ storeId, reconciliationDate: { $gte: startDate } })
        .populate('submittedBy', 'firstName lastName')
        .populate('approvedBy', 'firstName lastName')
        .sort({ reconciliationDate: -1 })
        .limit(10)
        .lean(),
      VenueReconciliation.countDocuments({ storeId, reconciliationStatus: 'pending' })
    ]);

    return {
      stats: stats || {
        totalReconciliations: 0,
        averageComplianceScore: null,
        totalVariance: 0,
        flaggedCount: 0,
        approvedCount: 0
      },
      recentReconciliations,
      pendingCount,
      complianceRating: this.calculateComplianceRating(stats)
    };
  }

  /**
   * Get system-wide compliance overview (for gambino_ops/super_admin)
   */
  static async getSystemComplianceOverview() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalStores, todaySubmissions, flaggedReconciliations, lowComplianceVenues] = await Promise.all([
      Store.countDocuments({ status: 'active' }),
      VenueReconciliation.countDocuments({ 
        reconciliationDate: { $gte: today } 
      }),
      VenueReconciliation.countDocuments({ 
        reconciliationStatus: 'flagged' 
      }),
      VenueReconciliation.aggregate([
        {
          $match: {
            reconciliationDate: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
            complianceScore: { $lt: 80 }
          }
        },
        {
          $group: {
            _id: '$storeId',
            averageScore: { $avg: '$complianceScore' },
            count: { $sum: 1 }
          }
        },
        { $sort: { averageScore: 1 } },
        { $limit: 10 }
      ])
    ]);

    const submissionRate = totalStores > 0 ? (todaySubmissions / totalStores) * 100 : 0;

    return {
      totalStores,
      todaySubmissions,
      submissionRate: Math.round(submissionRate),
      flaggedReconciliations,
      lowComplianceVenues,
      systemHealth: this.calculateSystemHealth(submissionRate, flaggedReconciliations, totalStores)
    };
  }

  /**
   * Approve a reconciliation
   */
  static async approveReconciliation(reconciliationId, approvedBy, notes = '') {
    const reconciliation = await VenueReconciliation.findById(reconciliationId);
    if (!reconciliation) {
      throw new Error('Reconciliation not found');
    }

    if (reconciliation.reconciliationStatus === 'approved') {
      throw new Error('Reconciliation already approved');
    }

    reconciliation.reconciliationStatus = 'approved';
    reconciliation.approvedBy = approvedBy;
    reconciliation.approvedAt = new Date();
    if (notes) {
      reconciliation.notes = reconciliation.notes ? `${reconciliation.notes}\n${notes}` : notes;
    }

    return reconciliation.save();
  }

  /**
   * Flag a reconciliation for review
   */
  static async flagReconciliation(reconciliationId, flaggedReason, flaggedBy) {
    const reconciliation = await VenueReconciliation.findById(reconciliationId);
    if (!reconciliation) {
      throw new Error('Reconciliation not found');
    }

    reconciliation.reconciliationStatus = 'flagged';
    reconciliation.flaggedReason = flaggedReason;
    // Note: We don't have a flaggedBy field, but we could add it to the notes
    reconciliation.notes = reconciliation.notes 
      ? `${reconciliation.notes}\nFlagged by user: ${flaggedReason}` 
      : `Flagged: ${flaggedReason}`;

    return reconciliation.save();
  }

  // Helper methods
  static calculateComplianceRating(stats) {
    if (!stats || stats.averageComplianceScore === null) {
      return 'Unknown';
    }

    const score = stats.averageComplianceScore;
    if (score >= 95) return 'Excellent';
    if (score >= 90) return 'Good';
    if (score >= 80) return 'Fair';
    if (score >= 70) return 'Poor';
    return 'Critical';
  }

  static calculateSystemHealth(submissionRate, flaggedCount, totalStores) {
    if (submissionRate >= 90 && flaggedCount / totalStores < 0.05) return 'Healthy';
    if (submissionRate >= 75 && flaggedCount / totalStores < 0.10) return 'Good';
    if (submissionRate >= 50 && flaggedCount / totalStores < 0.20) return 'Fair';
    return 'Needs Attention';
  }
}

module.exports = ReconciliationService;