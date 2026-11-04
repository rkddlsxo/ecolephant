import math
from .common import require


def check_policy(policy):
    require(policy['release_approved'] is False,'Draft fixture must not become an approved production profile')
    require(policy['camera_mapping_status']=='unvalidated','Draft camera mapping state changed without new profile')
    require(0<policy['thresholds_deg']['caution']<policy['thresholds_deg']['high']<=90,'Invalid angle bounds')
    require(math.isclose(sum(policy['fusion_weights'].values()),1),'Weights must sum to one')
    require(policy['quality']['window_ms']==1000,'Window duration differs from contract')
    require(policy['transport']['batch_max_items']==60 and policy['transport']['batch_max_bytes']==65536,'Transport limits disagree with API')
    require(policy['alerts']['adaptive_reduction_enabled'] is False,'Adaptive reduction requires an approved rule')
    require(bool(policy['provenance']['source_initial_values']) and bool(policy['provenance']['design_proposals']),'Missing policy provenance')
    print('PASS draft policy: explicit provenance, transport bounds, unapproved mapping')
