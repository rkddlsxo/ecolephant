import math


def semantic_errors(name,value,policy):
    errors=[]
    if name=='SampleWindow' and value['quality']=='valid' and policy.get('camera_judgement')=='change':
        mode=value['active_mode']
        if value['camera_estimate_deg'] is not None and policy['camera_mapping_status']!='validated':
            errors.append('webcam degrees stored before the mapping is validated')
        if mode in {'webcam','combined'} and (value.get('camera_forward_change') is None or value.get('camera_drop_change') is None):
            errors.append('webcam change values missing')
        if value['display_angle_deg']!=value['head_flexion_deg']:
            errors.append('display angle must be the measured AirPods angle or null')
        allowed={'normal':{'within_range'},'caution':{'head_flexion','mixed_caution'},'high':{'combined_high','forward_shift','head_flexion'}}
        if value['reason_code'] not in allowed[value['posture_level']]:
            errors.append('inconsistent reason and level')
        if (value['posture_level']=='normal')!=(value.get('posture_type') is None):
            errors.append('posture type must be set exactly when the level is not normal')
    elif name=='SampleWindow' and value['quality']=='valid':
        mode=value['active_mode']
        if value['display_angle_deg'] is None or (mode!='airpods' and value['camera_estimate_deg'] is None):
            errors.append('angle policy needs degrees')
            return errors
        if mode=='combined':
            weights=policy['fusion_weights']
            expected=value['camera_estimate_deg']*weights['webcam']+value['head_flexion_deg']*weights['airpods']
        else:
            expected=value['camera_estimate_deg'] if mode=='webcam' else value['head_flexion_deg']
        if not math.isclose(value['display_angle_deg'],expected,abs_tol=1e-6):
            errors.append('display angle does not match fixture policy')
        allowed={'normal':{'within_range'},'caution':{'head_flexion','mixed_caution'},'high':{'combined_high','forward_shift','head_flexion'}}
        if value['reason_code'] not in allowed[value['posture_level']]:
            errors.append('inconsistent reason and level')
    elif name=='SampleBatch':
        seen={}
        for window in value['samples']:
            seq=window['seq']
            if seq in seen and seen[seq]!=window:
                errors.append('same sequence has conflicting content')
            seen[seq]=window
            errors.extend(semantic_errors('SampleWindow',window,policy))
        ordered=sorted(seen.values(),key=lambda w:w['seq'])
        for previous,current in zip(ordered,ordered[1:]):
            previous_end=previous['elapsed_start_ms']+previous['duration_ms']
            if current['elapsed_start_ms']<previous_end:
                errors.append('overlapping sample windows')
            if current['seq']==previous['seq']+1:
                if current['elapsed_start_ms']!=previous_end:
                    errors.append('non-contiguous adjacent windows')
                if previous['duration_ms']!=1000:
                    errors.append('short non-final window')
        if ordered and ordered[0]['seq']==1 and ordered[0]['elapsed_start_ms']!=0:
            errors.append('first window must start at zero')
    elif name=='MetricSummary':
        valid=value['valid_duration_ms']
        if sum(value[k] for k in ['normal_duration_ms','caution_duration_ms','high_duration_ms'])!=valid:
            errors.append('valid duration decomposition mismatch')
        if value['forward_head_suspected_ms']>value['high_duration_ms']:
            errors.append('forward-head duration exceeds high duration')
        if valid==0:
            if value['mean_display_angle_deg'] is not None or value['within_range_percent'] is not None:
                errors.append('zero denominator must be null')
        # The mean angle may be null with valid time: change-based webcam windows carry no degrees.
        elif value['within_range_percent'] is None or not math.isclose(value['within_range_percent'],100*value['normal_duration_ms']/valid,abs_tol=1e-6):
            errors.append('normal ratio or mean presence mismatch')
        corrected=value['corrected_alert_count']
        if corrected+value['unknown_correction_count']>value['first_stage_alert_count']:
            errors.append('correction count exceeds delivered first alerts')
        if (corrected==0)!=(value['mean_correction_ms'] is None):
            errors.append('correction mean nullability mismatch')
    elif name=='EventBatch':
        sequences={}
        identifiers={}
        for event in value['events']:
            if event['event_seq'] in sequences and sequences[event['event_seq']]!=event:
                errors.append('conflicting event sequence')
            if event['event_id'] in identifiers and identifiers[event['event_id']]!=event:
                errors.append('conflicting event identifier')
            sequences[event['event_seq']]=event
            identifiers[event['event_id']]=event
    elif name=='Session':
        if value['status']=='active' and (value['ended_at'] is not None or value['final_seq'] is not None or value['final_event_seq'] is not None):
            errors.append('active session has completion data')
        if value['status']=='completed' and (value['ended_at'] is None or value['final_seq'] is None or value['final_event_seq'] is None or value['acknowledged_through_seq']!=value['final_seq'] or value['acknowledged_through_event_seq']!=value['final_event_seq']):
            errors.append('incomplete completion metadata')
        for summary in value['summaries']:
            errors.extend(semantic_errors('MetricSummary',summary['metrics'],policy))
    elif name=='TimelineBucket':
        if sum(value[k] for k in ['normal_ms','caution_ms','high_ms','unknown_ms'])!=value['duration_ms']:
            errors.append('bucket duration decomposition mismatch')
    return errors
