// src/middleware/machineAuth.js
const jwt = require('jsonwebtoken');

/**
 * Middleware to authenticate machine/Pi requests using JWT tokens
 * Validates tokens with type: 'machine' or type: 'hub'
 */
function authenticateMachine(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Machine authentication required',
      code: 'NO_TOKEN'
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const secret = process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET;
    
    jwt.verify(token, secret, (err, decoded) => {
      if (err) {
        console.error('❌ Machine token verification failed:', err.message);
        return res.status(401).json({
          error: 'Invalid machine token',
          code: 'INVALID_TOKEN',
          details: err.message
        });
      }

      // Check if it's a machine/hub token
      if (decoded.type !== 'machine' && decoded.type !== 'hub') {
        console.error('❌ Token is not a machine token, type:', decoded.type);
        return res.status(401).json({
          error: 'Invalid token type',
          code: 'WRONG_TOKEN_TYPE'
        });
      }

      // Attach machine info to request
      req.machine = {
        machineId: decoded.machineId,
        hubId: decoded.hubId,
        storeId: decoded.storeId,
        type: decoded.type,
        iat: decoded.iat,
        exp: decoded.exp
      };

      console.log('✅ Machine authenticated:', {
        machineId: req.machine.machineId,
        hubId: req.machine.hubId,
        storeId: req.machine.storeId,
        type: req.machine.type
      });

      return next();
    });
  } catch (error) {
    console.error('❌ Machine auth error:', error);
    return res.status(500).json({
      error: 'Authentication error',
      code: 'AUTH_ERROR'
    });
  }
}

module.exports = { authenticateMachine };
